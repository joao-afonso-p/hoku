// Thin VS Code glue for the Hoku bridge. All protocol logic lives in ./bridge.
//
// It never calls `sendText`, never reads terminal output, names or cwd, and never writes a
// setting. It does nothing at all outside macOS.

import { rmSync } from "node:fs";
import * as os from "node:os";
import * as vscode from "vscode";
import {
  EXTENSION_AUTHORITY,
  PROCESS_ID_TIMEOUT_MS,
  PUBLISH_DEBOUNCE_MS,
  PUBLISH_INTERVAL_MS,
  type BridgePaths,
  type DebouncedRunner,
  type HostFacade,
  bridgePaths,
  buildWindowRecord,
  createDebouncedRunner,
  createUriHandler,
  hostStartedAt,
  publishWindowRecord,
  windowIdFromQuery,
  windowRecordPath,
  withTimeout,
} from "./bridge.js";

const URI_HANDLED_KEY = "hoku.uriHandledBefore";

interface Active {
  paths: BridgePaths;
  hostPid: number;
  runner: DebouncedRunner;
  interval: ReturnType<typeof setInterval>;
}

let active: Active | undefined;

export function activate(context: vscode.ExtensionContext): void {
  if (process.platform !== "darwin") return;

  const paths = bridgePaths(os.homedir());
  const hostPid = process.pid;
  const startedAt = hostStartedAt(Date.now(), process.uptime());
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  const extensionVersion = String(context.extension.packageJSON?.version ?? "0.0.0");
  const ignore = () => undefined;

  const currentWindowId = async (): Promise<number | null> => {
    try {
      const external = await vscode.env.asExternalUri(
        vscode.Uri.parse(`${vscode.env.uriScheme}://${EXTENSION_AUTHORITY}/focus`),
      );
      return windowIdFromQuery(external.query);
    } catch {
      return null;
    }
  };

  const publish = async () => {
    const remote = vscode.env.remoteName !== undefined;
    const terminals = remote
      ? []
      : await Promise.all(
          vscode.window.terminals.map(async (terminal) => {
            const exited = terminal.exitStatus !== undefined;
            const pid = exited ? undefined : await withTimeout(terminal.processId, PROCESS_ID_TIMEOUT_MS, undefined);
            return { exited, pid };
          }),
        );
    const record = buildWindowRecord({
      extensionVersion,
      scheme: vscode.env.uriScheme,
      appVersion: vscode.version,
      hostPid,
      hostStartedAt: startedAt,
      windowId: await currentWindowId(),
      remote,
      uriHandledBefore: context.globalState.get<boolean>(URI_HANDLED_KEY, false) === true,
      terminals,
      now: Date.now(),
    });
    if (runner.disposed) return;
    await publishWindowRecord(paths, record);
    // deactivate() may have removed the record while this write was in flight.
    if (runner.disposed) rmSync(windowRecordPath(paths, hostPid), { force: true });
  };

  const runner = createDebouncedRunner(publish, PUBLISH_DEBOUNCE_MS, ignore);
  const schedule = () => runner.schedule();
  const watchProcessId = (terminal: vscode.Terminal) => {
    Promise.resolve(terminal.processId).then(schedule, ignore);
  };

  const host: HostFacade = {
    terminals: () =>
      vscode.window.terminals.map((terminal) => ({
        exited: terminal.exitStatus !== undefined,
        processId: terminal.processId,
        show: (preserveFocus: boolean) => terminal.show(preserveFocus),
      })),
    isRemote: () => vscode.env.remoteName !== undefined,
    currentWindowId,
    isFocused: () => vscode.window.state.focused,
    onDidChangeFocus: (listener) => vscode.window.onDidChangeWindowState((state) => listener(state.focused)),
    markUriHandled: () => context.globalState.update(URI_HANDLED_KEY, true),
    republish: schedule,
  };
  const handler = createUriHandler(host, { paths, uid, hostPid, now: Date.now, onError: ignore });

  context.subscriptions.push(
    vscode.window.registerUriHandler({
      // Returns undefined synchronously; the request is handled in a detached task (A1).
      handleUri(uri: vscode.Uri): void {
        handler.handleUri({ path: uri.path, query: uri.query });
      },
    }),
    vscode.window.onDidOpenTerminal((terminal) => {
      schedule();
      watchProcessId(terminal);
    }),
    vscode.window.onDidCloseTerminal(schedule),
    vscode.window.onDidChangeTerminalState(schedule),
  );
  vscode.window.terminals.forEach(watchProcessId);

  const interval = setInterval(schedule, PUBLISH_INTERVAL_MS);
  active = { paths, hostPid, runner, interval };
  schedule();
}

export function deactivate(): void {
  if (!active) return;
  const { paths, hostPid, runner, interval } = active;
  active = undefined;
  runner.dispose();
  clearInterval(interval);
  try {
    rmSync(windowRecordPath(paths, hostPid), { force: true });
  } catch {
    // Nothing else to do; Hoku ignores records whose host process is gone.
  }
}
