import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BridgePaths,
  type Disposable,
  type FacadeTerminal,
  type HostFacade,
  type Reply,
  type ReplyStatus,
  bridgePaths,
  buildReply,
  buildWindowRecord,
  claimRequest,
  createDebouncedRunner,
  createUriHandler,
  PING_MAX_AGE_MS,
  ensureBridgeDirs,
  hostStartedAt,
  parseBridgeUri,
  publishWindowRecord,
  removeWindowRecord,
  waitForFocus,
  windowIdFromQuery,
  windowRecordPath,
  writeFileAtomic,
} from "./bridge.js";

const ID = "0123456789abcdef0123456789abcdef";
const ID2 = "fedcba9876543210fedcba9876543210";
const UID = process.getuid!();

let home: string;
let paths: BridgePaths;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "hoku-vscode-test-"));
  paths = bridgePaths(home);
});

afterEach(async () => {
  vi.useRealTimers();
  await fs.rm(home, { recursive: true, force: true });
});

const mode = async (p: string) => (await fs.stat(p)).mode & 0o777;

async function writeRequest(id: string, body: Record<string, unknown>): Promise<void> {
  await ensureBridgeDirs(paths);
  await fs.writeFile(path.join(paths.requests, `${id}.json`), JSON.stringify(body), { mode: 0o600 });
}

const focusRequest = (overrides: Record<string, unknown> = {}) => ({
  schema: 1,
  id: ID,
  kind: "focus",
  pid: 456,
  windowId: 3,
  createdAt: Date.now(),
  ...overrides,
});

async function readReply(id = ID): Promise<Reply | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(paths.replies, `${id}.json`), "utf8")) as Reply;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------

describe("bridgePaths", () => {
  it("lives under Hoku's Application Support folder", () => {
    const p = bridgePaths("/Users/someone");
    expect(p.root).toBe("/Users/someone/Library/Application Support/com.hoku.app/vscode-bridge");
    expect(p.windows).toBe(`${p.root}/windows`);
    expect(p.requests).toBe(`${p.root}/requests`);
    expect(p.replies).toBe(`${p.root}/replies`);
    expect(windowRecordPath(p, 123)).toBe(`${p.root}/windows/123.json`);
  });
});

describe("window record", () => {
  const base = {
    extensionVersion: "0.1.0",
    scheme: "vscode",
    appVersion: "1.90.0",
    hostPid: 123,
    hostStartedAt: 1_700_000_000_000,
    windowId: 3,
    remote: false,
    uriHandledBefore: false,
    now: 1_700_000_000_500,
  };

  it("lists only live terminals with resolved positive integer pids", () => {
    const record = buildWindowRecord({
      ...base,
      terminals: [
        { exited: false, pid: 456 },
        { exited: true, pid: 457 },
        { exited: false, pid: undefined },
        { exited: false, pid: null },
        { exited: false, pid: 0 },
        { exited: false, pid: -4 },
        { exited: false, pid: 1.5 },
        { exited: false, pid: 789 },
      ],
    });
    expect(record).toEqual({
      schema: 1,
      extensionVersion: "0.1.0",
      scheme: "vscode",
      appVersion: "1.90.0",
      hostPid: 123,
      hostStartedAt: 1_700_000_000_000,
      windowId: 3,
      remote: false,
      uriHandledBefore: false,
      terminals: [{ pid: 456 }, { pid: 789 }],
      updatedAt: 1_700_000_000_500,
    });
  });

  it("lists no terminals for a remote window", () => {
    const record = buildWindowRecord({ ...base, remote: true, terminals: [{ exited: false, pid: 456 }] });
    expect(record.remote).toBe(true);
    expect(record.terminals).toEqual([]);
  });

  it("never includes terminal names or other fields", () => {
    const terminals = [{ exited: false, pid: 456, name: "secret-terminal-name", cwd: "/Users/someone/project" }];
    const json = JSON.stringify(buildWindowRecord({ ...base, terminals }));
    expect(json).not.toContain("secret-terminal-name");
    expect(json).not.toContain("/Users/someone");
    expect(JSON.parse(json).terminals).toEqual([{ pid: 456 }]);
  });

  it("computes hostStartedAt from the uptime", () => {
    expect(hostStartedAt(1_700_000_010_000, 10.0004)).toBe(1_700_000_000_000);
  });

  it("publishes and removes the record with private modes", async () => {
    const record = buildWindowRecord({ ...base, terminals: [{ exited: false, pid: 456 }] });
    await publishWindowRecord(paths, record);
    const file = windowRecordPath(paths, 123);
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual(record);
    expect(await mode(file)).toBe(0o600);
    await removeWindowRecord(paths, 123);
    expect(existsSync(file)).toBe(false);
    await removeWindowRecord(paths, 123); // already gone: no error
  });
});

describe("atomic writes", () => {
  it("creates the folders 0700 and files 0600, leaving no temp files", async () => {
    await ensureBridgeDirs(paths);
    for (const dir of [paths.root, paths.windows, paths.requests, paths.replies]) {
      expect(await mode(dir)).toBe(0o700);
    }
    await writeFileAtomic(paths.replies, "a.json", "{}");
    await writeFileAtomic(paths.replies, "a.json", '{"v":2}');
    expect(await fs.readFile(path.join(paths.replies, "a.json"), "utf8")).toBe('{"v":2}');
    expect(await mode(path.join(paths.replies, "a.json"))).toBe(0o600);
    expect(await fs.readdir(paths.replies)).toEqual(["a.json"]);
  });

  it("tightens existing bridge folders to 0700 without touching com.hoku.app", async () => {
    const appDir = path.dirname(paths.root);
    await fs.mkdir(paths.windows, { recursive: true, mode: 0o755 });
    await fs.chmod(appDir, 0o755);
    await fs.chmod(paths.root, 0o755);
    await fs.chmod(paths.windows, 0o755);
    await ensureBridgeDirs(paths);
    expect(await mode(paths.root)).toBe(0o700);
    expect(await mode(paths.windows)).toBe(0o700);
    expect(await mode(appDir)).toBe(0o755);
  });

  it("refuses a symlinked bridge folder instead of following it", async () => {
    const elsewhere = path.join(home, "elsewhere");
    await fs.mkdir(elsewhere, { mode: 0o755 });
    await fs.mkdir(path.dirname(paths.root), { recursive: true });
    await fs.symlink(elsewhere, paths.root);
    await expect(ensureBridgeDirs(paths)).rejects.toThrow();
    expect(await fs.readdir(elsewhere)).toEqual([]);
    expect(await mode(elsewhere)).toBe(0o755);
  });

  it("refuses a bridge subfolder that is a file or belongs to another user", async () => {
    await fs.mkdir(paths.root, { recursive: true });
    await fs.writeFile(paths.windows, "x");
    await expect(ensureBridgeDirs(paths)).rejects.toThrow();
    await fs.rm(paths.windows);
    await expect(ensureBridgeDirs(paths, UID + 1)).rejects.toThrow();
    await expect(ensureBridgeDirs(paths, UID)).resolves.toBeUndefined();
  });

  it("writes the temp file with wx, so an existing temp name fails", async () => {
    await ensureBridgeDirs(paths);
    await fs.writeFile(path.join(paths.replies, "a.json.tmp-deadbeef"), "x");
    await expect(writeFileAtomic(paths.replies, "a.json", "{}", () => "deadbeef")).rejects.toThrow();
    expect(existsSync(path.join(paths.replies, "a.json"))).toBe(false);
  });
});

describe("URI parsing", () => {
  it("parses focus and ping", () => {
    expect(parseBridgeUri("/focus", `windowId=3&request=${ID}`)).toEqual({ kind: "focus", id: ID, windowId: 3 });
    expect(parseBridgeUri("/ping", `request=${ID}`)).toEqual({ kind: "ping", id: ID });
  });

  it("keeps a focus URI without a usable windowId, as windowId null", () => {
    expect(parseBridgeUri("/focus", `request=${ID}`)).toEqual({ kind: "focus", id: ID, windowId: null });
    expect(parseBridgeUri("/focus", `windowId=x&request=${ID}`)).toEqual({ kind: "focus", id: ID, windowId: null });
    expect(parseBridgeUri("/focus", `windowId=3&windowId=4&request=${ID}`)).toMatchObject({ windowId: null });
  });

  it.each(["", "/", "/Focus", "/focus/", "/pong", "/focus/../ping", "focus", "//focus"])("rejects path %j", (p) => {
    expect(parseBridgeUri(p, `windowId=3&request=${ID}`)).toBeNull();
  });

  it.each([
    "",
    "request=",
    `request=${ID.toUpperCase()}`,
    `request=${ID.slice(1)}`,
    `request=${ID}0`,
    `request=${ID.slice(1)}g`,
    `request=../${ID.slice(3)}`,
    `request=${ID}&request=${ID2}`,
    `id=${ID}`,
  ])("rejects query %j", (q) => {
    expect(parseBridgeUri("/ping", q)).toBeNull();
    expect(parseBridgeUri("/focus", `windowId=3&${q}`)).toBeNull();
  });

  it("reads windowId from an external URI query", () => {
    expect(windowIdFromQuery("windowId=7")).toBe(7);
    expect(windowIdFromQuery("a=b&windowId=12")).toBe(12);
    expect(windowIdFromQuery("")).toBeNull();
    expect(windowIdFromQuery("windowId=-1")).toBeNull();
    expect(windowIdFromQuery("windowId=99999999999999999999")).toBeNull();
  });
});

describe("claimRequest", () => {
  const claim = (overrides: Partial<Parameters<typeof claimRequest>[0]> = {}) =>
    claimRequest({ paths, id: ID, kind: "focus", uid: UID, windowId: 3, now: Date.now, ...overrides });

  it("claims a valid focus request and deletes it", async () => {
    const body = focusRequest();
    await writeRequest(ID, body);
    expect(await claim()).toEqual({ ok: true, request: body });
    expect(await fs.readdir(paths.requests)).toEqual([]);
  });

  it("claims a valid ping request", async () => {
    const body = { schema: 1, id: ID, kind: "ping", createdAt: Date.now() };
    await writeRequest(ID, body);
    expect(await claim({ kind: "ping", windowId: null })).toEqual({ ok: true, request: body });
  });

  it("is single use: a second claim is expired", async () => {
    await writeRequest(ID, focusRequest());
    expect((await claim()).ok).toBe(true);
    expect(await claim()).toEqual({ ok: false });
  });

  it("is expired when there is no request", async () => {
    await ensureBridgeDirs(paths);
    expect(await claim()).toEqual({ ok: false });
  });

  it("rejects a symlink without touching its target", async () => {
    await ensureBridgeDirs(paths);
    const target = path.join(home, "target.json");
    await fs.writeFile(target, JSON.stringify(focusRequest()));
    await fs.symlink(target, path.join(paths.requests, `${ID}.json`));
    expect(await claim()).toEqual({ ok: false });
    expect(existsSync(target)).toBe(true);
  });

  it("rejects an oversize request", async () => {
    await writeRequest(ID, { ...focusRequest(), padding: "x".repeat(4096) });
    expect(await claim()).toEqual({ ok: false });
  });

  it("rejects a request owned by another uid", async () => {
    await writeRequest(ID, focusRequest());
    expect(await claim({ uid: UID + 1 })).toEqual({ ok: false });
  });

  it("accepts createdAt at the edges and rejects stale or future requests", async () => {
    const now = 1_700_000_000_000;
    const at = (createdAt: number) => async () => {
      await writeRequest(ID, focusRequest({ createdAt }));
      return (await claim({ now: () => now })).ok;
    };
    expect(await at(now - 15_000)()).toBe(true);
    expect(await at(now + 2_000)()).toBe(true);
    expect(await at(now - 15_001)()).toBe(false);
    expect(await at(now + 2_001)()).toBe(false);
  });

  it("gives a ping 75 s, longer than Hoku's 60 s wait through VS Code's link prompt", async () => {
    const now = 1_700_000_000_000;
    const ping = async (createdAt: number) => {
      await writeRequest(ID, { schema: 1, id: ID, kind: "ping", createdAt });
      return (await claim({ kind: "ping", windowId: null, now: () => now })).ok;
    };
    expect(PING_MAX_AGE_MS).toBeGreaterThanOrEqual(60_000);
    expect(await ping(now - 60_000)).toBe(true);
    expect(await ping(now - 75_000)).toBe(true);
    expect(await ping(now - 75_001)).toBe(false);
    // Focus requests keep their short age.
    await writeRequest(ID, focusRequest({ createdAt: now - 20_000 }));
    expect((await claim({ now: () => now })).ok).toBe(false);
  });

  it.each([
    ["kind mismatch", { kind: "ping" }],
    ["windowId mismatch", { windowId: 4 }],
    ["id mismatch", { id: ID2 }],
    ["schema", { schema: 2 }],
    ["pid zero", { pid: 0 }],
    ["pid string", { pid: "456" }],
    ["createdAt string", { createdAt: String(Date.now()) }],
  ])("rejects a request with %s", async (_label, overrides) => {
    await writeRequest(ID, focusRequest(overrides));
    expect(await claim()).toEqual({ ok: false });
    expect(await fs.readdir(paths.requests)).toEqual([]);
  });

  it("rejects malformed JSON", async () => {
    await ensureBridgeDirs(paths);
    await fs.writeFile(path.join(paths.requests, `${ID}.json`), "{not json");
    expect(await claim()).toEqual({ ok: false });
  });
});

describe("replies", () => {
  it.each<ReplyStatus>(["shown", "not-found", "wrong-window", "expired", "remote", "pong"])(
    "builds a %s reply",
    (status) => {
      const shown = status === "shown";
      const reply = buildReply({
        id: ID,
        kind: status === "pong" ? "ping" : "focus",
        windowId: 3,
        hostPid: 123,
        status,
        shownAt: shown ? 10 : undefined,
        focusedAt: shown ? 20 : undefined,
        repliedAt: 30,
      });
      expect(reply).toEqual({
        schema: 1,
        id: ID,
        kind: status === "pong" ? "ping" : "focus",
        windowId: 3,
        hostPid: 123,
        status,
        shownAt: shown ? 10 : null,
        focusedAt: shown ? 20 : null,
        repliedAt: 30,
      });
    },
  );
});

// ---------------------------------------------------------------------------------------
// The URI handler through a fake VS Code facade

class FakeTerminal implements FacadeTerminal {
  shows: { preserveFocus: boolean; at: number }[] = [];
  private onShow: (() => void)[] = [];
  readonly processId: PromiseLike<number | undefined>;
  constructor(
    pid: number | undefined,
    readonly exited = false,
  ) {
    this.processId = Promise.resolve(pid);
  }
  show(preserveFocus: boolean): void {
    this.shows.push({ preserveFocus, at: Date.now() });
    this.onShow.splice(0).forEach((f) => f());
  }
  /** Resolves on the next show(). */
  shown(): Promise<void> {
    return new Promise((resolve) => this.onShow.push(resolve));
  }
}

class FakeHost implements HostFacade {
  focused = false;
  remote = false;
  windowId: number | null = 3;
  handledMarks = 0;
  republishes = 0;
  private listeners = new Set<(focused: boolean) => void>();
  constructor(public list: FakeTerminal[] = []) {}
  terminals() {
    return this.list;
  }
  isRemote() {
    return this.remote;
  }
  async currentWindowId() {
    return this.windowId;
  }
  isFocused() {
    return this.focused;
  }
  onDidChangeFocus(listener: (focused: boolean) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }
  markUriHandled() {
    this.handledMarks += 1;
  }
  republish() {
    this.republishes += 1;
  }
  /** What VS Code's focusWindow(Force) does, from the extension's point of view. */
  setFocused(focused: boolean) {
    this.focused = focused;
    for (const listener of [...this.listeners]) listener(focused);
  }
}

const isThenable = (value: unknown) =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  typeof (value as { then?: unknown }).then === "function";

function setup(options: { focusTimeoutMs?: number; terminals?: FakeTerminal[] } = {}) {
  const terminal = new FakeTerminal(456);
  const host = new FakeHost(options.terminals ?? [new FakeTerminal(111), new FakeTerminal(456, true), terminal]);
  const handler = createUriHandler(host, {
    paths,
    uid: UID,
    hostPid: 123,
    now: Date.now,
    focusTimeoutMs: options.focusTimeoutMs ?? 1_000,
    onError: (error) => {
      throw error;
    },
  });
  return { host, handler, terminal };
}

const focusUri = (windowId: number | string = 3, id = ID) => ({ path: "/focus", query: `windowId=${windowId}&request=${id}` });

describe("A1 ordering: handleUri returns before VS Code focuses the window", () => {
  it("returns undefined synchronously, then acknowledges the focus VS Code applies afterwards", async () => {
    const { host, handler, terminal } = setup();
    await writeRequest(ID, focusRequest());
    const createdAt = (JSON.parse(await fs.readFile(path.join(paths.requests, `${ID}.json`), "utf8")) as { createdAt: number }).createdAt;

    // VS Code's ExtHostUrls calls handleUri synchronously and doesn't await its result.
    const returned = handler.handleUri(focusUri()) as unknown;
    expect(returned).toBeUndefined();
    expect(isThenable(returned)).toBe(false);
    expect(terminal.shows).toEqual([]);
    expect(await readReply()).toBeNull();

    // Only now does the RPC resolve and VS Code force-focus the window.
    host.setFocused(true);

    await handler.whenIdle();
    const reply = await readReply();
    expect(reply).toMatchObject({ id: ID, kind: "focus", windowId: 3, hostPid: 123, status: "shown" });
    expect(terminal.shows).toEqual([{ preserveFocus: false, at: reply!.shownAt }]);
    expect(reply!.shownAt).not.toBeNull();
    expect(reply!.focusedAt).not.toBeNull();
    expect(createdAt).toBeLessThanOrEqual(reply!.shownAt!);
    expect(reply!.shownAt!).toBeLessThanOrEqual(reply!.focusedAt!);
    expect(reply!.focusedAt!).toBeLessThanOrEqual(reply!.repliedAt);
    expect(host.handledMarks).toBe(1);
    expect(host.republishes).toBe(1);
    expect(await fs.readdir(paths.requests)).toEqual([]);
  });

  it("acknowledges a focus that arrives only after show()", async () => {
    const { host, handler, terminal } = setup();
    await writeRequest(ID, focusRequest());
    const shown = terminal.shown();
    expect(handler.handleUri(focusUri())).toBeUndefined();
    await shown;
    expect(await readReply()).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));
    host.setFocused(true);
    await handler.whenIdle();
    const reply = (await readReply())!;
    expect(reply.status).toBe("shown");
    expect(reply.shownAt!).toBeLessThanOrEqual(reply.focusedAt!);
    expect(reply.focusedAt! - reply.shownAt!).toBeGreaterThanOrEqual(15);
  });

  it("(a) a pessimistic host that awaits the handler's result still gets focus acknowledged", async () => {
    const { host, handler } = setup();
    await writeRequest(ID, focusRequest());
    // A host that awaits whatever handleUri returned: it must not hang.
    await handler.handleUri(focusUri());
    host.setFocused(true);
    await handler.whenIdle();
    const reply = (await readReply())!;
    expect(reply.status).toBe("shown");
    expect(reply.focusedAt).not.toBeNull();
    expect(reply.shownAt!).toBeLessThanOrEqual(reply.focusedAt!);
  });

  it("(b) focus never arrives: focusedAt is null after the bound", async () => {
    const { handler, terminal } = setup({ focusTimeoutMs: 40 });
    await writeRequest(ID, focusRequest());
    const started = Date.now();
    expect(handler.handleUri(focusUri())).toBeUndefined();
    await handler.whenIdle();
    const reply = (await readReply())!;
    expect(reply).toMatchObject({ status: "shown", focusedAt: null });
    expect(reply.shownAt).toBe(terminal.shows[0].at);
    expect(reply.repliedAt - started).toBeGreaterThanOrEqual(35);
  });

  it("(b) the default bound is 1500 ms", async () => {
    vi.useFakeTimers();
    let result: number | null | undefined;
    void waitForFocus({
      isFocused: () => false,
      onDidChangeFocus: () => ({ dispose() {} }),
      shownAt: 0,
      now: () => 1,
    }).then((value) => (result = value));
    await vi.advanceTimersByTimeAsync(1_499);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBeNull();
  });

  it("(c) focus before shownAt doesn't count", async () => {
    const { host, handler } = setup({ focusTimeoutMs: 40 });
    await writeRequest(ID, focusRequest());
    // The window had focus, then lost it, all before the request was handled.
    host.setFocused(true);
    host.setFocused(false);
    expect(handler.handleUri(focusUri())).toBeUndefined();
    await handler.whenIdle();
    expect(await readReply()).toMatchObject({ status: "shown", focusedAt: null });
  });

  it("(c) a focus event stamped before shownAt is ignored, a later one counts", async () => {
    let clock = 1_000;
    let listener: ((focused: boolean) => void) | undefined;
    const pending = waitForFocus({
      isFocused: () => false,
      onDidChangeFocus: (l) => {
        listener = l;
        return { dispose: () => (listener = undefined) };
      },
      shownAt: 1_000,
      now: () => clock,
      timeoutMs: 1_000,
    });
    clock = 999; // a clock that observed the focus before show()
    listener!(true);
    expect(listener).toBeDefined();
    clock = 1_005;
    listener!(false);
    listener!(true);
    expect(await pending).toBe(1_005);
    expect(listener).toBeUndefined();
  });

  it("counts the current state when the window is already focused right after show()", async () => {
    const value = await waitForFocus({
      isFocused: () => true,
      onDidChangeFocus: () => ({ dispose() {} }),
      shownAt: 50,
      now: () => 60,
      timeoutMs: 1_000,
    });
    expect(value).toBe(60);
  });
});

describe("concurrent focus requests in one window", () => {
  it("a newer request supersedes a pending one, which never reports focus", async () => {
    const { host, handler, terminal } = setup();
    await writeRequest(ID, focusRequest());
    const firstShown = terminal.shown();
    handler.handleUri(focusUri(3, ID));
    await firstShown;

    await writeRequest(ID2, focusRequest({ id: ID2 }));
    const secondShown = terminal.shown();
    handler.handleUri(focusUri(3, ID2));
    await secondShown;
    // The one focus event VS Code applies belongs to the newer click only.
    host.setFocused(true);
    await handler.whenIdle();

    const older = (await readReply(ID))!;
    const newer = (await readReply(ID2))!;
    expect(older).toMatchObject({ status: "superseded", focusedAt: null });
    expect(older.shownAt).not.toBeNull();
    expect(newer).toMatchObject({ status: "shown" });
    expect(newer.focusedAt).not.toBeNull();
    expect(terminal.shows).toHaveLength(2);
  });

  it("a request superseded before it shows its terminal doesn't show it", async () => {
    let release: (pid: number) => void = () => undefined;
    const slow: FacadeTerminal & { shows: number } = {
      exited: false,
      processId: new Promise<number>((resolve) => (release = resolve)),
      shows: 0,
      show() {
        this.shows += 1;
      },
    };
    const host = new FakeHost();
    host.terminals = () => [slow as unknown as FakeTerminal];
    host.focused = true;
    const handler = createUriHandler(host, { paths, uid: UID, hostPid: 123, now: Date.now, focusTimeoutMs: 100, processIdTimeoutMs: 1_000 });
    await writeRequest(ID, focusRequest());
    handler.handleUri(focusUri(3, ID));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeRequest(ID2, focusRequest({ id: ID2 }));
    handler.handleUri(focusUri(3, ID2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    release(456);
    await handler.whenIdle();
    expect(await readReply(ID)).toMatchObject({ status: "superseded", shownAt: null, focusedAt: null });
    expect(await readReply(ID2)).toMatchObject({ status: "shown" });
    expect(slow.shows).toBe(1);
  });

  it("an expired or wrong-window request doesn't supersede a valid one", async () => {
    const { host, handler, terminal } = setup();
    await writeRequest(ID, focusRequest());
    const shown = terminal.shown();
    handler.handleUri(focusUri(3, ID));
    await shown;
    handler.handleUri(focusUri(3, ID2)); // no request file: expired
    handler.handleUri(focusUri(4, ID2)); // another window
    await new Promise((resolve) => setTimeout(resolve, 20));
    host.setFocused(true);
    await handler.whenIdle();
    expect(await readReply(ID)).toMatchObject({ status: "shown" });
    expect((await readReply(ID))!.focusedAt).not.toBeNull();
  });

  it("waitForFocus resolves null at once when aborted", async () => {
    const controller = new AbortController();
    const pending = waitForFocus({
      isFocused: () => false,
      onDidChangeFocus: () => ({ dispose() {} }),
      shownAt: 0,
      now: () => 1,
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    controller.abort();
    expect(await pending).toBeNull();
  });
});

describe("URI handler statuses", () => {
  it("replies wrong-window without claiming the request", async () => {
    const { host, handler } = setup();
    await writeRequest(ID, focusRequest({ windowId: 4 }));
    handler.handleUri(focusUri(4));
    await handler.whenIdle();
    expect(await readReply()).toMatchObject({ id: ID, kind: "focus", windowId: 3, hostPid: 123, status: "wrong-window", shownAt: null, focusedAt: null });
    expect(existsSync(path.join(paths.requests, `${ID}.json`))).toBe(true);
    expect(host.handledMarks).toBe(0);
  });

  it("replies wrong-window when the URI has no windowId or the window has none", async () => {
    const { host, handler } = setup();
    await writeRequest(ID, focusRequest());
    handler.handleUri({ path: "/focus", query: `request=${ID}` });
    await handler.whenIdle();
    expect((await readReply())!.status).toBe("wrong-window");
    host.windowId = null;
    await fs.rm(paths.replies, { recursive: true });
    handler.handleUri(focusUri());
    await handler.whenIdle();
    expect(await readReply()).toMatchObject({ status: "wrong-window", windowId: null });
  });

  it("replies expired for a missing request and for a reused one", async () => {
    const { host, handler } = setup({ focusTimeoutMs: 10 });
    handler.handleUri(focusUri());
    await handler.whenIdle();
    expect(await readReply()).toMatchObject({ status: "expired", shownAt: null, focusedAt: null });

    await writeRequest(ID2, focusRequest({ id: ID2 }));
    handler.handleUri(focusUri(3, ID2));
    await handler.whenIdle();
    expect((await readReply(ID2))!.status).toBe("shown");
    handler.handleUri(focusUri(3, ID2));
    await handler.whenIdle();
    expect((await readReply(ID2))!.status).toBe("expired");
    expect(host.handledMarks).toBe(1);
  });

  it("replies pong to a ping", async () => {
    const { host, handler } = setup();
    await writeRequest(ID, { schema: 1, id: ID, kind: "ping", createdAt: Date.now() });
    handler.handleUri({ path: "/ping", query: `request=${ID}` });
    await handler.whenIdle();
    expect(await readReply()).toMatchObject({ id: ID, kind: "ping", windowId: 3, hostPid: 123, status: "pong", shownAt: null, focusedAt: null });
    expect(host.handledMarks).toBe(1);
    expect(host.republishes).toBe(1);
  });

  it("replies remote in a remote window, without showing anything", async () => {
    const { host, handler, terminal } = setup();
    host.remote = true;
    await writeRequest(ID, focusRequest());
    handler.handleUri(focusUri());
    await handler.whenIdle();
    expect((await readReply())!.status).toBe("remote");
    expect(terminal.shows).toEqual([]);
  });

  it("replies not-found when no live terminal has the pid", async () => {
    const exited = new FakeTerminal(456, true);
    const { handler } = setup({ terminals: [new FakeTerminal(111), exited, new FakeTerminal(undefined)] });
    await writeRequest(ID, focusRequest());
    handler.handleUri(focusUri());
    await handler.whenIdle();
    expect(await readReply()).toMatchObject({ status: "not-found", shownAt: null, focusedAt: null });
    expect(exited.shows).toEqual([]);
  });

  it("does not wait forever on a processId that never resolves", async () => {
    const hanging: FacadeTerminal = { exited: false, processId: new Promise(() => {}), show() {} };
    const host = new FakeHost();
    host.terminals = () => [hanging as FakeTerminal];
    const handler = createUriHandler(host, { paths, uid: UID, hostPid: 123, now: Date.now, processIdTimeoutMs: 20 });
    await writeRequest(ID, focusRequest());
    handler.handleUri(focusUri());
    await handler.whenIdle();
    expect((await readReply())!.status).toBe("not-found");
  });

  it.each([
    { path: "/other", query: `request=${ID}` },
    { path: "/focus", query: "windowId=3&request=nope" },
    { path: "/ping", query: "" },
  ])("ignores %j with no reply", async (uri) => {
    const { host, handler } = setup();
    await writeRequest(ID, focusRequest());
    expect(handler.handleUri(uri)).toBeUndefined();
    await handler.whenIdle();
    expect(await fs.readdir(paths.replies)).toEqual([]);
    expect(host.republishes).toBe(0);
  });
});

describe("debounced publisher", () => {
  it("coalesces bursts and stops after dispose", async () => {
    vi.useFakeTimers();
    let runs = 0;
    const runner = createDebouncedRunner(async () => {
      runs += 1;
    }, 200);
    runner.schedule();
    await vi.advanceTimersByTimeAsync(100);
    runner.schedule();
    runner.schedule();
    await vi.advanceTimersByTimeAsync(199);
    expect(runs).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toBe(1);
    runner.schedule();
    runner.dispose();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runs).toBe(1);
    expect(runner.disposed).toBe(true);
  });

  it("never runs two publishes at once", async () => {
    vi.useFakeTimers();
    let concurrent = 0;
    let maxConcurrent = 0;
    let runs = 0;
    const runner = createDebouncedRunner(async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 500));
      concurrent -= 1;
      runs += 1;
    }, 200);
    runner.schedule();
    await vi.advanceTimersByTimeAsync(300); // first run in flight
    runner.schedule();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(runs).toBe(2);
    expect(maxConcurrent).toBe(1);
  });
});
