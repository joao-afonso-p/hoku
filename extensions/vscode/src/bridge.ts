// Pure logic for the Hoku <-> VS Code bridge (protocol v1). Nothing here imports `vscode`:
// paths, the clock, the uid and the VS Code surface are injected so all of it is testable.
//
// Privacy: the only things this module ever writes are process numbers, a window number,
// versions and timestamps. It never reads terminal content, names, cwd or workspace paths.

import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export const SCHEMA = 1;
export const EXTENSION_AUTHORITY = "joao-afonso-p.hoku-vscode";
export const MAX_REQUEST_BYTES = 4096;
/** A focus request is valid when `createdAt` is in [now - 15000, now + 2000]. */
export const REQUEST_MAX_AGE_MS = 15_000;
/**
 * A ping may be older: VS Code asks the user whether to allow the link before it calls
 * `handleUri`, and Hoku waits 60 s for that answer, so a ping stays valid for 75 s.
 */
export const PING_MAX_AGE_MS = 75_000;
export const REQUEST_MAX_FUTURE_MS = 2_000;
export const FOCUS_ACK_TIMEOUT_MS = 1_500;
export const PUBLISH_DEBOUNCE_MS = 200;
export const PUBLISH_INTERVAL_MS = 60_000;
/** How long to wait for a terminal's `processId` before treating it as unresolved. */
export const PROCESS_ID_TIMEOUT_MS = 1_000;

const REQUEST_ID = /^[0-9a-f]{32}$/;
const DIGITS = /^\d+$/;

export interface Disposable {
  dispose(): void;
}

// ---------------------------------------------------------------------------------------
// Paths and files

export interface BridgePaths {
  root: string;
  windows: string;
  requests: string;
  replies: string;
}

/** `<home>/Library/Application Support/com.hoku.app/vscode-bridge/` and its subfolders. */
export function bridgePaths(home: string): BridgePaths {
  const root = path.join(home, "Library", "Application Support", "com.hoku.app", "vscode-bridge");
  return {
    root,
    windows: path.join(root, "windows"),
    requests: path.join(root, "requests"),
    replies: path.join(root, "replies"),
  };
}

export function windowRecordPath(paths: BridgePaths, hostPid: number): string {
  return path.join(paths.windows, `${hostPid}.json`);
}

/**
 * Creates the bridge folders (mode 0700) and `chmod 0700`s `vscode-bridge` and its
 * subfolders. Never chmods `com.hoku.app` itself. Like Hoku, it refuses a bridge folder that
 * is a symlink, isn't a folder, or belongs to another user, rather than following it.
 */
export async function ensureBridgeDirs(
  paths: BridgePaths,
  uid: number | undefined = typeof process.getuid === "function" ? process.getuid() : undefined,
): Promise<void> {
  // `com.hoku.app` (and anything above it) may be created, but is never chmodded.
  await fs.mkdir(path.dirname(paths.root), { recursive: true, mode: 0o700 });
  for (const dir of [paths.root, paths.windows, paths.requests, paths.replies]) {
    try {
      await fs.mkdir(dir, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = await fs.lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid)) {
      throw new Error("the bridge folder isn't a private folder");
    }
    await fs.chmod(dir, 0o700);
  }
}

/**
 * Writes `<dir>/<name>` atomically with mode 0600: writes `<name>.tmp-<8 hex>` with flag
 * `wx`, then renames it over the final name.
 */
export async function writeFileAtomic(
  dir: string,
  name: string,
  contents: string,
  randomHex: () => string = () => randomBytes(4).toString("hex"),
): Promise<void> {
  const tmp = path.join(dir, `${name}.tmp-${randomHex()}`);
  const handle = await fs.open(tmp, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(tmp, path.join(dir, name));
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

// ---------------------------------------------------------------------------------------
// windows/<hostPid>.json

/** A terminal as the publisher sees it. Only `exited` and `pid` are ever used. */
export interface TerminalSnapshot {
  exited: boolean;
  /** The resolved `processId`, or undefined/null when it hasn't resolved. */
  pid: number | null | undefined;
}

export interface WindowRecord {
  schema: 1;
  extensionVersion: string;
  scheme: string;
  appVersion: string;
  hostPid: number;
  hostStartedAt: number;
  windowId: number | null;
  remote: boolean;
  uriHandledBefore: boolean;
  terminals: { pid: number }[];
  updatedAt: number;
}

export interface WindowRecordInput {
  extensionVersion: string;
  scheme: string;
  appVersion: string;
  hostPid: number;
  hostStartedAt: number;
  windowId: number | null;
  remote: boolean;
  uriHandledBefore: boolean;
  terminals: readonly TerminalSnapshot[];
  now: number;
}

export function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** `Math.round(now - uptime * 1000)`: when this extension host started. */
export function hostStartedAt(nowMs: number, uptimeSeconds: number): number {
  return Math.round(nowMs - uptimeSeconds * 1000);
}

/** Live terminals with a resolved positive pid, as `{pid}` only. Remote windows list none. */
export function terminalPids(terminals: readonly TerminalSnapshot[], remote: boolean): { pid: number }[] {
  if (remote) return [];
  const out: { pid: number }[] = [];
  for (const terminal of terminals) {
    if (terminal.exited || !isPositiveInt(terminal.pid)) continue;
    out.push({ pid: terminal.pid });
  }
  return out;
}

export function buildWindowRecord(input: WindowRecordInput): WindowRecord {
  return {
    schema: SCHEMA,
    extensionVersion: input.extensionVersion,
    scheme: input.scheme,
    appVersion: input.appVersion,
    hostPid: input.hostPid,
    hostStartedAt: input.hostStartedAt,
    windowId: input.windowId,
    remote: input.remote,
    uriHandledBefore: input.uriHandledBefore,
    terminals: terminalPids(input.terminals, input.remote),
    updatedAt: input.now,
  };
}

export async function publishWindowRecord(paths: BridgePaths, record: WindowRecord): Promise<void> {
  await ensureBridgeDirs(paths);
  await writeFileAtomic(paths.windows, `${record.hostPid}.json`, JSON.stringify(record));
}

export async function removeWindowRecord(paths: BridgePaths, hostPid: number): Promise<void> {
  await fs.rm(windowRecordPath(paths, hostPid), { force: true });
}

// ---------------------------------------------------------------------------------------
// URIs

/** The `windowId=(\d+)` query parameter of a URI (from `asExternalUri`), or null. */
export function windowIdFromQuery(query: string): number | null {
  const values = new URLSearchParams(query).getAll("windowId");
  if (values.length !== 1 || !DIGITS.test(values[0])) return null;
  const id = Number(values[0]);
  return Number.isSafeInteger(id) ? id : null;
}

export type RequestKind = "focus" | "ping";

export type BridgeUri =
  | { kind: "focus"; id: string; windowId: number | null }
  | { kind: "ping"; id: string };

/**
 * Parses `/focus?windowId=<digits>&request=<id>` or `/ping?request=<id>`. Anything else
 * (another path, a missing, repeated or malformed `request`) returns null: ignore it, with
 * no reply.
 */
export function parseBridgeUri(uriPath: string, query: string): BridgeUri | null {
  if (uriPath !== "/focus" && uriPath !== "/ping") return null;
  const requests = new URLSearchParams(query).getAll("request");
  if (requests.length !== 1 || !REQUEST_ID.test(requests[0])) return null;
  const id = requests[0];
  if (uriPath === "/ping") return { kind: "ping", id };
  return { kind: "focus", id, windowId: windowIdFromQuery(query) };
}

export function isRequestId(id: string): boolean {
  return REQUEST_ID.test(id);
}

// ---------------------------------------------------------------------------------------
// requests/<id>.json

export interface ValidRequest {
  schema: 1;
  id: string;
  kind: RequestKind;
  /** Focus only. */
  pid?: number;
  /** Focus only. */
  windowId?: number;
  createdAt: number;
}

export interface ClaimOptions {
  paths: BridgePaths;
  id: string;
  kind: RequestKind;
  /** The uid the request file must belong to (`process.getuid()`). */
  uid: number;
  /** This window's current windowId (focus requests must match it). */
  windowId: number | null;
  now: () => number;
}

export type ClaimResult = { ok: true; request: ValidRequest } | { ok: false };

/**
 * Claims `requests/<id>.json`: it must be a regular file (not a symlink) owned by `uid` and
 * at most 4096 bytes. It's renamed to `<id>.claimed` (so a request is single use), read,
 * deleted and validated. Any failure is `{ ok: false }`, which the caller replies as
 * `expired`.
 */
export async function claimRequest(options: ClaimOptions): Promise<ClaimResult> {
  const { paths, id } = options;
  if (!isRequestId(id)) return { ok: false };
  const requestFile = path.join(paths.requests, `${id}.json`);
  const claimedFile = path.join(paths.requests, `${id}.claimed`);

  try {
    const stat = await fs.lstat(requestFile);
    if (!acceptableFile(stat, options.uid)) return { ok: false };
  } catch {
    return { ok: false };
  }
  try {
    await fs.rename(requestFile, claimedFile);
  } catch {
    return { ok: false };
  }

  let text: string;
  try {
    text = await readClaimed(claimedFile, options.uid);
  } catch {
    return { ok: false };
  } finally {
    await fs.rm(claimedFile, { force: true }).catch(() => undefined);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false };
  }
  const request = validateRequest(parsed, options);
  return request ? { ok: true, request } : { ok: false };
}

interface StatLike {
  isFile(): boolean;
  isSymbolicLink(): boolean;
  uid: number;
  size: number;
}

function acceptableFile(stat: StatLike, uid: number): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.uid === uid && stat.size <= MAX_REQUEST_BYTES;
}

/** Reads the claimed file without following symlinks and re-checks it on the open handle. */
async function readClaimed(file: string, uid: number): Promise<string> {
  const handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!acceptableFile(stat, uid)) throw new Error("unacceptable request file");
    const buffer = Buffer.alloc(MAX_REQUEST_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_REQUEST_BYTES) throw new Error("request file too large");
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

export function validateRequest(
  value: unknown,
  expected: { id: string; kind: RequestKind; windowId: number | null; now: () => number },
): ValidRequest | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (r.schema !== SCHEMA) return null;
  if (r.id !== expected.id) return null;
  if (r.kind !== expected.kind) return null;
  const createdAt = r.createdAt;
  if (typeof createdAt !== "number" || !Number.isSafeInteger(createdAt)) return null;
  const now = expected.now();
  const maxAge = expected.kind === "ping" ? PING_MAX_AGE_MS : REQUEST_MAX_AGE_MS;
  if (createdAt < now - maxAge || createdAt > now + REQUEST_MAX_FUTURE_MS) return null;
  if (expected.kind === "ping") {
    return { schema: SCHEMA, id: expected.id, kind: "ping", createdAt };
  }
  if (expected.windowId === null || r.windowId !== expected.windowId) return null;
  if (!isPositiveInt(r.pid)) return null;
  return { schema: SCHEMA, id: expected.id, kind: "focus", pid: r.pid, windowId: expected.windowId, createdAt };
}

// ---------------------------------------------------------------------------------------
// replies/<id>.json

/**
 * `superseded`: a newer focus request reached this window before this one finished, so this
 * one never confirms focus (and may not have shown its terminal at all).
 */
export type ReplyStatus = "shown" | "not-found" | "wrong-window" | "expired" | "remote" | "superseded" | "pong";

export interface Reply {
  schema: 1;
  id: string;
  kind: RequestKind;
  windowId: number | null;
  hostPid: number;
  status: ReplyStatus;
  shownAt: number | null;
  focusedAt: number | null;
  repliedAt: number;
}

export function buildReply(input: {
  id: string;
  kind: RequestKind;
  windowId: number | null;
  hostPid: number;
  status: ReplyStatus;
  shownAt?: number | null;
  focusedAt?: number | null;
  repliedAt: number;
}): Reply {
  return {
    schema: SCHEMA,
    id: input.id,
    kind: input.kind,
    windowId: input.windowId,
    hostPid: input.hostPid,
    status: input.status,
    shownAt: input.shownAt ?? null,
    focusedAt: input.focusedAt ?? null,
    repliedAt: input.repliedAt,
  };
}

export async function writeReply(paths: BridgePaths, reply: Reply): Promise<void> {
  if (!isRequestId(reply.id)) throw new Error("invalid request id");
  await ensureBridgeDirs(paths);
  await writeFileAtomic(paths.replies, `${reply.id}.json`, JSON.stringify(reply));
}

// ---------------------------------------------------------------------------------------
// Focus acknowledgement

export interface FocusWaitOptions {
  /** `vscode.window.state.focused`, read right now. */
  isFocused: () => boolean;
  /** `vscode.window.onDidChangeWindowState`, reduced to the `focused` flag. */
  onDidChangeFocus: (listener: (focused: boolean) => void) => Disposable;
  /** When `terminal.show()` was called. Only focus observed at or after it counts. */
  shownAt: number;
  now: () => number;
  timeoutMs?: number;
  /** Aborted when a newer focus request supersedes this one: resolves null at once. */
  signal?: AbortSignal;
}

/**
 * Resolves with the moment the window is focused (at or after `shownAt`), or null when it
 * isn't within `timeoutMs` (1500 ms by default). The current state counts if it's already
 * focused when this is called (right after `show()`); otherwise it waits for a change to
 * focused. An aborted `signal` resolves null.
 */
export function waitForFocus(options: FocusWaitOptions): Promise<number | null> {
  const timeoutMs = options.timeoutMs ?? FOCUS_ACK_TIMEOUT_MS;
  return new Promise((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let subscription: Disposable | undefined;
    const onAbort = () => finish(null);
    const finish = (value: number | null) => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      subscription?.dispose();
      options.signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    if (options.signal?.aborted) return finish(null);
    options.signal?.addEventListener("abort", onAbort);
    const observeFocus = () => {
      const at = options.now();
      if (at >= options.shownAt) finish(at);
    };
    timer = setTimeout(() => finish(null), timeoutMs);
    subscription = options.onDidChangeFocus((focused) => {
      if (focused) observeFocus();
    });
    if (done) subscription.dispose();
    else if (options.isFocused()) observeFocus();
  });
}

// ---------------------------------------------------------------------------------------
// URI handling (A1: `handleUri` returns void at once; the work runs in a detached task)

/** A terminal through the VS Code facade. */
export interface FacadeTerminal {
  /** `exitStatus !== undefined`. */
  readonly exited: boolean;
  readonly processId: PromiseLike<number | undefined>;
  show(preserveFocus: boolean): void;
}

/** The slice of VS Code the URI handler needs; tests provide a fake. */
export interface HostFacade {
  terminals(): readonly FacadeTerminal[];
  /** `vscode.env.remoteName !== undefined`. */
  isRemote(): boolean;
  /** Re-resolved on every call (from `asExternalUri`), or null. */
  currentWindowId(): Promise<number | null>;
  isFocused(): boolean;
  onDidChangeFocus(listener: (focused: boolean) => void): Disposable;
  /** Sets `uriHandledBefore = true` in globalState. */
  markUriHandled(): PromiseLike<void> | void;
  /** Schedules a (debounced) publish of the window record. */
  republish(): void;
}

export interface HandlerContext {
  paths: BridgePaths;
  uid: number;
  hostPid: number;
  now: () => number;
  focusTimeoutMs?: number;
  processIdTimeoutMs?: number;
  onError?: (error: unknown) => void;
}

export interface UriHandlerCore {
  /** Returns undefined synchronously; the work is scheduled as a detached task. */
  handleUri(uri: { path: string; query: string }): void;
  /** Resolves when every scheduled task has finished (tests and deactivate). */
  whenIdle(): Promise<void>;
}

/**
 * Orders the focus requests one window handles: `begin()` aborts the previous request's
 * signal, so only the newest click can show its terminal and confirm focus. Two clicks
 * would otherwise both see the same focus event and both report it.
 */
export interface FocusGate {
  begin(): AbortSignal;
}

export function createFocusGate(): FocusGate {
  let current: AbortController | undefined;
  return {
    begin() {
      current?.abort();
      current = new AbortController();
      return current.signal;
    },
  };
}

export function createUriHandler(host: HostFacade, ctx: HandlerContext): UriHandlerCore {
  const pending = new Set<Promise<void>>();
  const gate = createFocusGate();
  return {
    handleUri(uri) {
      const parsed = parseBridgeUri(uri.path, uri.query);
      if (!parsed) return undefined;
      // Nothing below runs before handleUri has returned: VS Code focuses the window only
      // after this synchronous part completes, and it doesn't await what we return.
      const task: Promise<void> = Promise.resolve()
        .then(async () => {
          await processUri(host, ctx, parsed, gate);
        })
        .catch((error: unknown) => {
          ctx.onError?.(error);
        })
        .finally(() => {
          pending.delete(task);
        });
      pending.add(task);
      return undefined;
    },
    async whenIdle() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
}

/**
 * The detached task behind one URI: claim, act, reply, mark handled, republish. A focus
 * request superseded (through `gate`) by a newer one replies `superseded` with no focusedAt,
 * and doesn't show its terminal if it hadn't yet.
 */
export async function processUri(
  host: HostFacade,
  ctx: HandlerContext,
  uri: BridgeUri,
  gate: FocusGate = createFocusGate(),
): Promise<Reply> {
  const windowId = await host.currentWindowId();
  const reply = (status: ReplyStatus, shownAt: number | null = null, focusedAt: number | null = null) =>
    buildReply({ id: uri.id, kind: uri.kind, windowId, hostPid: ctx.hostPid, status, shownAt, focusedAt, repliedAt: ctx.now() });
  const send = async (r: Reply, validated: boolean) => {
    await writeReply(ctx.paths, r);
    if (validated) await host.markUriHandled();
    host.republish();
    return r;
  };

  if (uri.kind === "focus" && (uri.windowId === null || windowId === null || uri.windowId !== windowId)) {
    return send(reply("wrong-window"), false);
  }

  const claim = await claimRequest({ paths: ctx.paths, id: uri.id, kind: uri.kind, uid: ctx.uid, windowId, now: ctx.now });
  if (!claim.ok) return send(reply("expired"), false);

  if (uri.kind === "ping") return send(reply("pong"), true);
  if (host.isRemote()) return send(reply("remote"), true);

  const signal = gate.begin();
  const terminal = await findTerminal(host.terminals(), claim.request.pid!, ctx.processIdTimeoutMs ?? PROCESS_ID_TIMEOUT_MS);
  if (signal.aborted) return send(reply("superseded"), true);
  if (!terminal) return send(reply("not-found"), true);

  terminal.show(false);
  const shownAt = ctx.now();
  const focusedAt = await waitForFocus({
    isFocused: () => host.isFocused(),
    onDidChangeFocus: (listener) => host.onDidChangeFocus(listener),
    shownAt,
    now: ctx.now,
    timeoutMs: ctx.focusTimeoutMs,
    signal,
  });
  if (signal.aborted) return send(reply("superseded", shownAt, null), true);
  return send(reply("shown", shownAt, focusedAt), true);
}

/** The first live terminal whose awaited `processId` equals `pid`. */
export async function findTerminal(
  terminals: readonly FacadeTerminal[],
  pid: number,
  timeoutMs: number = PROCESS_ID_TIMEOUT_MS,
): Promise<FacadeTerminal | undefined> {
  const live = terminals.filter((t) => !t.exited);
  const pids = await Promise.all(live.map((t) => withTimeout(t.processId, timeoutMs, undefined)));
  const index = pids.findIndex((p) => p === pid);
  return index >= 0 ? live[index] : undefined;
}

/** Resolves with `value`'s result, or `fallback` if it rejects or takes longer than `ms`. */
export function withTimeout<T, F>(value: PromiseLike<T>, ms: number, fallback: F): Promise<T | F> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    Promise.resolve(value).then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

// ---------------------------------------------------------------------------------------
// Publishing

export interface DebouncedRunner extends Disposable {
  schedule(): void;
  readonly disposed: boolean;
}

/**
 * Runs `task` `delayMs` after the last `schedule()`, never two at once (a schedule during a
 * run queues one more run). After `dispose()` nothing runs.
 */
export function createDebouncedRunner(
  task: () => Promise<void>,
  delayMs: number = PUBLISH_DEBOUNCE_MS,
  onError?: (error: unknown) => void,
): DebouncedRunner {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let again = false;
  let disposed = false;
  const run = async () => {
    timer = undefined;
    if (disposed) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      await task();
    } catch (error) {
      onError?.(error);
    } finally {
      running = false;
      if (again && !disposed) {
        again = false;
        schedule();
      }
    }
  };
  const schedule = () => {
    if (disposed) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(run, delayMs);
  };
  return {
    schedule,
    dispose() {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
    get disposed() {
      return disposed;
    },
  };
}
