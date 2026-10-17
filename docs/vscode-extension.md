# The Hoku VS Code extension

Hoku can't tell from the outside which VS Code window, or which integrated-terminal tab, a
Claude Code session runs in. The optional Hoku VS Code extension fills that gap: each VS Code
window reports the process numbers of its terminals to Hoku through a private folder, and Hoku
asks the right window, through a VS Code link, to show the session's terminal and come forward.
Without the extension, **Go to terminal** behaves as before: it activates VS Code and the user
picks the tab.

This page is the contributor reference: architecture, the bridge protocol, matching, focus
sequencing, the threat model, packaging, tests and how publishing could work later. The user
guide's page is `site/src/content/docs/guides/vscode-extension.mdx`, and the extension's own
README is [extensions/vscode/README.md](../extensions/vscode/README.md).

## Overview

| | |
|---|---|
| Extension ID | `joao-afonso-p.hoku-vscode` (publisher `joao-afonso-p`, name `hoku-vscode`, display name "Hoku") |
| Version | 0.1.0 (`BUNDLED_EXTENSION_VERSION` in `vscode_bridge.rs` must equal `version` in `extensions/vscode/package.json`; a Rust test checks it) |
| Supported | VS Code stable and VS Code Insiders, local windows, macOS only. Minimum engine 1.90 |
| Not supported | Remote windows (SSH, dev containers, WSL, Codespaces); forks (Cursor, VSCodium, Windsurf) |
| Distribution | Bundled inside Hoku.app as `Contents/Resources/vscode/hoku-vscode.vsix` and installed offline. **Not published** to the Visual Studio Marketplace or Open VSX |
| Scope | Per VS Code profile. The URI-trust checkbox is per profile too |

Install paths:

- **From Hoku.** The setup sheet (opened from a Go to terminal toast, or from Integrations)
  has **Install in VS Code** and, when Insiders is present, **Install in VS Code Insiders**.
  Hoku runs VS Code's own CLI from the app bundle, with fixed arguments and no shell:
  `<VS Code.app>/Contents/Resources/app/bin/code --install-extension <Hoku.app>/Contents/Resources/vscode/hoku-vscode.vsix --force`
  (`bin/code-insiders` for Insiders). The app is found by bundle id, with fallbacks to
  `/Applications` and `~/Applications`. `bin/code` is a shell script that starts VS Code's
  own binary, so Hoku runs it in its own process group and, on a timeout (10 s to list, 120 s
  to install), kills the whole group.
- **By hand.** "Extensions: Install from VSIX…" in VS Code, pointing at the same VSIX.

Once installed, there's no per-project setup.

### Pieces

```
Hoku (Rust)                                   VS Code window (extension host, "ui" kind)
─────────────                                 ───────────────────────────────────────────
launch.rs focus_host_app / go_to_client       extensions/vscode/src/extension.ts  (VS Code glue)
  └─ vscode_bridge.rs                           └─ extensions/vscode/src/bridge.ts (pure logic)
       ProcTable, anchor, plan, attempt,
       vscode_result, gc                     publishes windows/<hostPid>.json
commands.rs vscode_extension_status,          handles <scheme>://joao-afonso-p.hoku-vscode/focus|ping
  install_vscode_extension, vscode_setup_ping   writes replies/<id>.json
src/features/integrations/VsCodeExtensionSheet.tsx, IntegrationCenter row, toast routing
```

- `extensions/vscode/` is a TypeScript extension with no runtime dependencies.
  `src/bridge.ts` holds the protocol logic and is unit-tested; `src/extension.ts` is thin glue
  over the VS Code API. Its type-checking and tests run from the repo root (`pnpm typecheck`,
  `pnpm test`); its dev dependencies (`@types/vscode`, `@vscode/vsce`) are in the root
  `package.json`.
- The extension declares `extensionKind: ["ui"]`, so in a remote window it still runs locally,
  where it can see that the window is remote. It activates on `onStartupFinished` and `onUri`,
  and supports untrusted and virtual workspaces because it reads no workspace content. On any
  platform other than macOS, `activate` returns immediately.
- `src-tauri/src/vscode_bridge.rs` holds everything on Hoku's side. Side effects (clock, sleep,
  process start times, `open`, the Spaces check) sit behind a small `Desktop` trait so the
  ordering is testable with a recording fake.

There is no listener, socket or server on either side. Hoku and the extension only exchange
small files in Hoku's own Application Support folder, and Hoku triggers the extension with a
VS Code link that macOS's LaunchServices delivers.

## Bridge protocol (v1)

### Folder

```
~/Library/Application Support/com.hoku.app/vscode-bridge/
  windows/    one record per VS Code window, written by the extension
  requests/   one file per click, written by Hoku
  replies/    one file per handled request, written by the extension
```

- `vscode-bridge/` and its subfolders are created with mode 0700, and both sides `chmod` them to
  0700. `com.hoku.app` itself is never chmod'ed. Both sides `lstat` each bridge folder first
  and refuse one that is a symlink, isn't a folder, or belongs to another user.
- Every file is mode 0600 and written atomically: `<name>.tmp-<8 hex>` opened with `wx` and
  0600, then renamed to the final name.
- The extension finds the folder from `os.homedir()`, Hoku from `association::home_dir()`.
- All timestamps are integer milliseconds since the epoch.

### `windows/<hostPid>.json` (extension)

```json
{ "schema": 1, "extensionVersion": "0.1.0", "scheme": "vscode", "appVersion": "1.139.1",
  "hostPid": 123, "hostStartedAt": 1700000000000, "windowId": 3, "remote": false,
  "uriHandledBefore": false, "terminals": [{ "pid": 456 }], "updatedAt": 1700000000000 }
```

- `scheme` is `vscode.env.uriScheme`: `vscode` or `vscode-insiders`.
- `hostPid` is the extension host's `process.pid`; `hostStartedAt` is
  `Math.round(Date.now() - process.uptime() * 1000)`.
- `windowId` is the number in the `windowId=` query parameter that VS Code appends to
  `asExternalUri(<scheme>://joao-afonso-p.hoku-vscode/focus)`, or `null`. It's re-resolved on
  every publish.
- `remote` is `vscode.env.remoteName !== undefined`. A remote record always has
  `terminals: []`, because remote PIDs could collide with local ones.
- `terminals` lists every terminal with no `exitStatus` and a resolved, positive `processId`
  (the terminal's shell). Only `{ pid }`: never names, cwd, paths or content.
- `uriHandledBefore` comes from the extension's `globalState`. It becomes true once any valid
  request has been handled and only changes wording on Hoku's side.
- Published on activation, on terminal open, close and state change, when a `processId`
  resolves, every 60 s and after a URI is handled, debounced by 200 ms. Deleted on
  `deactivate`.

### `requests/<id>.json` (Hoku)

```json
{ "schema": 1, "id": "<32 lowercase hex>", "kind": "focus", "pid": 456, "windowId": 3, "createdAt": 1700000000000 }
{ "schema": 1, "id": "<32 lowercase hex>", "kind": "ping", "createdAt": 1700000000000 }
```

`id` is a fresh 128-bit random value (UUID v4 without hyphens) per click or setup ping. `pid` is
the terminal's root process (see [Matching](#matching-and-confidence-limits)).

### URIs (Hoku opens them)

| URI | Opened with | When |
|---|---|---|
| `<scheme>://joao-afonso-p.hoku-vscode/focus?windowId=<digits>&request=<id>` | `/usr/bin/open -g` | Go to terminal |
| `<scheme>://joao-afonso-p.hoku-vscode/ping?request=<id>` | `/usr/bin/open` | the **Allow Hoku in VS Code** setup step only |

Hoku builds these from validated digits and hex and checks them against a strict regex before
opening:
`^(vscode|vscode-insiders)://joao-afonso-p\.hoku-vscode/(focus\?windowId=\d{1,9}&request=[0-9a-f]{32}|ping\?request=[0-9a-f]{32})$`.
It never opens a URI read from a record. `launch::allowed_url` is unchanged for the other
schemes.

### Extension URI handling

`handleUri` returns `void` immediately and runs the work as a detached async task (see
[A1](#verified-vs-code-ordering-a1)).

1. Parse the path (`/focus` or `/ping`) and `request` (`^[0-9a-f]{32}$`). Anything else is
   ignored with no reply.
2. `/focus`: if the URI's `windowId` isn't this window's current `windowId`, reply
   `wrong-window` without claiming the request.
3. Claim the request: `lstat requests/<id>.json` must be a regular file (not a symlink) owned by
   the current uid and ≤ 4096 bytes. Rename it to `requests/<id>.claimed` (single use; a failed
   rename means `expired`). Read it, then delete the `.claimed` file. It's `expired` unless
   `schema` is 1, `id` and `kind` match the URI, `createdAt` is within now − 15 s … now + 2 s
   (now − 75 s for a ping, since VS Code's trust dialog runs before `handleUri` and Hoku waits
   60 s for it), and, for focus, `windowId` is this window's and `pid` is a positive integer.
4. `/ping`: reply `pong`. No terminal is touched.
5. `/focus`: in a remote window reply `remote`. Otherwise this request becomes the window's
   newest focus request, superseding any older one still in progress. Find the terminal with
   no `exitStatus` whose `processId === pid` (each `processId` is awaited for at most 1 s;
   `not-found` if none), call `terminal.show(false)` and record `shownAt`.
6. Focus acknowledgement: if `window.state.focused` is already true right after `show()`,
   `focusedAt = now`. Otherwise wait up to 1.5 s for `onDidChangeWindowState` with
   `focused: true`. On timeout `focusedAt` is `null`.
7. Write the reply, set `uriHandledBefore`, and republish the record.

**Superseded requests.** Two clicks that reach the same window close together would otherwise
both see the one focus event VS Code applies and both report it. So a newer valid focus
request (one that passed steps 2–3) supersedes older ones in that window: an older request
still looking for its terminal replies `superseded` without showing it, and one already
waiting for focus stops waiting and replies `superseded` with `focusedAt: null`. Hoku never
treats `superseded` as precise and doesn't activate VS Code for it, since the newer click is
bringing the window forward.

The extension never calls `sendText`, never reads terminal buffers, never runs commands and
never writes a VS Code setting.

### `replies/<id>.json` (extension)

```json
{ "schema": 1, "id": "<id>", "kind": "focus", "windowId": 3, "hostPid": 123,
  "status": "shown", "shownAt": 1700000000100, "focusedAt": 1700000000300, "repliedAt": 1700000000310 }
```

`status` is one of `shown`, `not-found`, `wrong-window`, `expired`, `remote`, `superseded`
or `pong`.
`windowId` and `hostPid` are always the replying window's own. `shownAt` and `focusedAt` are
`null` unless set.

### Lifetimes

- Hoku deletes `requests/<id>.json`, `requests/<id>.claimed` and `replies/<id>.json` when it
  stops waiting, whatever the outcome (4.5 s for focus, 60 s for ping). A late reply, or a
  trust dialog approved after the timeout, therefore does nothing.
- On every Go to terminal in VS Code (before planning), every extension status check and every
  setup ping, Hoku garbage-collects anything in `requests/` or `replies/` older than 60 s, and
  window records whose extension host is dead or whose start time doesn't match. It never
  follows symlinks.
- When Hoku reads a record or reply it checks the file (regular, owned by the effective uid,
  within the size limit) with `lstat`, opens it with `O_NOFOLLOW`, and repeats the checks on
  the open handle.
- The extension deletes its window record on `deactivate`.

Nothing from the bridge is stored in `hub.sqlite`.

## Matching and confidence limits

When a live Claude Code session's host app is VS Code or VS Code Insiders, `focus_host_app`
takes one `ps -axo pid=,ppid=,comm=` snapshot (`ProcTable`) and runs `vscode_bridge::plan`.

**Anchor.** Walking up from the claude pid (at most 12 hops), the first ancestor-or-self whose
parent is a plain `Code Helper` (`Code - Insiders Helper`), which is the terminal's pty host, is
the terminal's **root**: the shell VS Code started, whose pid is `Terminal.processId`. This
covers `claude ← zsh`, `claude ← node (npx) ← bash ← zsh`, and claude as the terminal's own
process. A parent that's a `Code Helper (Plugin)` (extension host) means a Claude Code
extension-panel session. `ppid ≤ 1` (tmux, launchd) or a loop means no anchor.

**Record validation** (`read_records`): file name `^\d{1,10}\.json$`; a regular file (not a
symlink) owned by the effective uid, ≤ 16 KB; schema 1; `hostPid` equal to the file stem;
`scheme` `vscode` or `vscode-insiders`; strings ≤ 64 chars; ≤ 512 terminals; positive pids;
`windowId` ≤ 999 999 999. Invalid files are skipped, never followed.

A record is **live** for a flavour when its `scheme` matches, `hostPid` is a running
`Code Helper (Plugin)` of that flavour, and the process start time (`proc_pidinfo`
`pbi_start_tvsec`) is within 2 s of `hostStartedAt`.

**Order of checks and outcomes** (no URI is opened unless the result is `Precise`):

| Check | Outcome |
|---|---|
| Anchor is the extension host | `PanelSession`: today's fallback, no window-level claim |
| No anchor, or the claude PID-reuse guard fails | `Unverified`: today's fallback |
| Two or more main `Code` processes of the flavour (custom `--user-data-dir`) | `TwoInstances`: LaunchServices can't target an instance, so Hoku doesn't guess |
| No live record of the flavour | `NoExtension` |
| Live records, but none (non-remote, with a `windowId`) lists the root | `NotReporting`: a profile without the extension, a remote window, a window not reloaded, or tmux |
| More than one matching record | `Ambiguous` |
| Exactly one match, whose extension host belongs to the same main process as the pty host | `Precise`: go to the [attempt](#focus-sequencing) |

**PID-reuse guards:**

- Claude pid: its process start time must not be later than the registry's `startedAt` + 2 s.
  Skipped on the `go_to_client` path (`claude attach` clients and `claude agents` dashboards),
  which has no registry start time.
- Extension host: the start-time match above.
- Terminal pid: excluded by the extension once `exitStatus` is set, and re-checked live in the
  window at click time.

**Known limits:**

- VS Code's router matches `window:3` with a regex that also matches `window:31`. That only
  matters if window 3 is gone, and Hoku's binding on `windowId` then turns it into a rejection.
- Auxiliary (floating) terminal windows are unverified.
- Claude Code extension-panel sessions have no terminal and keep today's fallback.
- tmux inside a VS Code terminal breaks the process chain (the server's parent is launchd), so
  it stays "can't switch".
- The extension and the trust checkbox are per VS Code profile.
- Forks are unsupported: their process names and schemes don't match.
- The Spaces check after a confirmed focus asks whether *any* on-screen VS Code window is on
  the current desktop, not the targeted one: all VS Code windows belong to one process, and
  VS Code's `windowId` doesn't map to a macOS window number. With the macOS switch setting off,
  a session window on another desktop can therefore count as Precise when another VS Code
  window is on this one.

## Focus sequencing

The precise path is the only path that can produce "Switched to this session's terminal in VS
Code". Generic activation is a fallback that runs only after the attempt has finished or timed
out, never interleaved with it.

0. **Generation.** `commands::open_session` takes the next open generation. A click that's
   superseded by a newer open (of any session) before its result comes back never runs
   `bring_forward`, so a slow attempt's fallback can't activate VS Code over the newer click.
1. **`yield_to(HOST_BUNDLES)`.** `commands::open_session` (and `go_to_client`) then yields
   activation on the main thread while Hoku is still frontmost. Since macOS 14 activation is
   cooperative, and this yield is what lets VS Code's own focus request succeed.
2. **Plan** (above), after garbage-collecting the bridge folder. Anything but `Precise` goes
   straight to the fallback without opening a URI.
3. **Spaces pre-check.** If precise navigation can't even be tried and the existing Spaces
   condition applies (Hoku isn't full screen, the macOS switch setting is off, VS Code has no
   window on the current desktop), the result stays today's "on another desktop" hint.
4. **Attempt** (`vscode_bridge::attempt`): ensure the folders, write
   `requests/<id>.json`, then open the focus URI with **`/usr/bin/open -g`**. `-g` delivers the
   URL without activating VS Code's last-active window, so the only activation is VS Code
   focusing the targeted window itself.
5. **VS Code's own force-focus.** VS Code routes the URL to the window named by `windowId`,
   runs the extension's handler, then calls `focusWindow({ mode: FocusMode.Force })` on that
   window (see A1).
6. **The reply.** The extension shows the terminal, waits for the window to report focus, and
   writes the reply with `shownAt` and `focusedAt`. Hoku polls `replies/<id>.json` every 50 ms
   for up to 4.5 s: the extension's worst case is up to 1 s for terminal process ids plus up to
   1.5 s for focus, plus VS Code's own latency.
7. **Judging.** Precise only if all of these hold: the reply is exactly `replies/<this id>.json`;
   `id` and `kind` match; `windowId` and `hostPid` equal the targeted record's; `status` is
   `shown`; `createdAt ≤ shownAt ≤ focusedAt`; and the Spaces check passes (Hoku full screen,
   or the switch setting on, or VS Code has a window on the current desktop). Hoku then deletes
   the request and reply.
8. **Result.** On the precise path `OpenResult.activate` stays `None`, so `bring_forward` (and
   its `open -b` retry) never runs, and `OpenResult.exact` is true. A `superseded` reply also
   leaves `activate` empty. Every other outcome sets `activate = Some(bundle)`, and
   `bring_forward` activates VS Code generically after `attempt` has returned (if no newer open
   started meanwhile), with a message that doesn't claim the window or terminal.

### Messages

`{name}` is "VS Code" or "VS Code Insiders". The `hint` drives the frontend: `spaces-setting`
opens the Spaces help, `vscode-extension` opens the setup sheet once and then adds a **Set up
precise navigation** toast action (unless the user chose **Don't suggest this again**), and
`vscode-setup` adds a **Finish VS Code setup** action that opens the sheet at the Allow step.
Only an `exact` result (the precise rows) is a success toast; every other outcome, with or
without a hint, is an info toast.

| Outcome | Generic activation | Hint | Message |
|---|---|---|---|
| Precise (session) | no | none | "Switched to this session's terminal in {name}" |
| Precise (`claude agents` dashboard) | no | none | "Switched to `claude agents` in {name}. Pick this session there." |
| Shown, focus not confirmed | yes | none | "Selected the session's terminal in {name}, but couldn't confirm its window came forward." |
| Shown and focused, Spaces check fails | yes | `spaces-setting` | "The session is in {name} on another desktop" |
| No reply in 4.5 s, never handled a link before | yes | `vscode-setup` | "Switched to {name}, but it didn't confirm the session's window. {name} may be asking whether to allow the Hoku extension to open a link: choose Open, then click Go to terminal again." |
| No reply in 4.5 s, a link handled before (the dialog may still be asking: allowing once doesn't tick "Do not ask me again") | yes | `vscode-setup` | "Switched to {name}, but it didn't confirm the session's window and terminal. Pick it there." |
| Request couldn't be written or `open` failed | yes | none | "Switched to {name}, but Hoku couldn't send the request to select the session's window and terminal. Pick it there." |
| `not-found` | yes | none | "Switched to {name}, but the session's window didn't have its terminal any more. Pick it there." |
| `expired` | yes | none | "Switched to {name}, but the request reached the window too late. Pick the session's terminal there, or click Go to terminal again." |
| `wrong-window`, or a reply bound to another window or request | yes | none | "Switched to {name}, but a different window answered than the one holding the session. Pick it there." |
| `remote` | yes | none | "Switched to {name}. The session's window is a remote window, where Hoku can't select terminals. Pick it there." |
| Any other status or an invalid reply | yes | none | "Switched to {name}, but the window's answer didn't match the request. Pick the session's terminal there." |
| `superseded` (a newer click reached the window first) | no | none | "A newer Go to terminal click took over this {name} window." |
| Extension not connected | yes | `vscode-extension` | "Switched to {name}, where this session is running. Hoku couldn't select its window and terminal." |
| Window not reporting | yes | none | "Switched to {name}. This session's window isn't reporting to Hoku (reload it, or check the Hoku extension is installed in that VS Code profile)." |
| Ambiguous, or two instances | yes | none | "Switched to {name}. Hoku couldn't tell which window holds this session, so it didn't pick one." |
| Panel session, or unverified | yes | none | today's fallback wording, with "window and terminal" in place of "terminal tab" |

### URI trust

The first extension link in a VS Code profile shows VS Code's native dialog "Allow 'Hoku'
extension to open this URI?". The user chooses **Open** and ticks **Do not ask me again**.
Hoku and the extension **never** write `extensions.confirmedUriHandlerExtensionIds` or any
other VS Code setting.

Because the focus URI is delivered with `-g`, a first-time dialog could appear somewhere the
user doesn't see it. The setup sheet's **Allow Hoku in {name}** step (`vscode_setup_ping`)
makes it visible: Hoku yields, requires exactly one running instance of that flavour, writes a
`ping` request and opens the ping URI *without* `-g` and without `windowId`. LaunchServices
brings VS Code forward and the URL goes to the front window, so the dialog appears there. Hoku
waits up to 60 s for `pong` and reports `ready`, `no-reply`, `not-running` or `two-instances`.
This step is setup and is never presented as navigation. `ready` proves VS Code let the link
through this once; it can't tell whether **Do not ask me again** was ticked, so the sheet says
so, and a later focus timeout still offers **Finish VS Code setup**.

At click time a pending dialog looks like silence: the 4.5 s timeout produces a `vscode-setup`
message. Since the request is deleted on timeout, approving the dialog afterwards does nothing,
and the message says to click Go to terminal again.

## Verified VS Code ordering (A1)

The extension's focus acknowledgement depends on when VS Code focuses the window relative to
`handleUri`. From VS Code's source (`microsoft/vscode`, `main`):

- `src/vs/workbench/services/url/electron-browser/urlService.ts`,
  `RelayURLService.handleURL`: `const result = await super.open(uri, options); if (result)
  await nativeHostService.focusWindow({ mode: FocusMode.Force, targetWindowId: <this window> })`.
  Its `create` also appends `windowId=<this window>` to URIs made by `asExternalUri`.
- `super.open` iterates the URL handlers. The workbench's `ExtensionUrlHandler.handleURL`
  (`src/vs/workbench/services/extensions/browser/extensionUrlHandler.ts`) runs the trust check,
  showing the native confirm dialog unless the extension is trusted, and then returns false
  when the extension's handler is already registered. The per-extension handler from
  `src/vs/workbench/api/browser/mainThreadUrls.ts` then does
  `await this.proxy.$handleExternalUri(handle, uri); return true;`.
- `src/vs/workbench/api/common/extHostUrls.ts`, `$handleExternalUri`: calls
  `handler.handleUri(uri)` **synchronously, does not await its return value**, then returns
  `Promise.resolve(undefined)`.
- `src/vs/platform/url/common/urlIpc.ts`: `URLHandlerRouter` routes a URL carrying
  `windowId=N` to that window (regex `window:N`). Without it, `src/vs/code/electron-main/app.ts`
  uses `activeWindowRouter`, the window in front. That is what the setup ping relies on.

So the order is: trust dialog (if needed) → the synchronous part of `handleUri` → the RPC
resolves → `focusWindow(Force)`. Focus happens **after** `handleUri`'s synchronous part
returns, whatever the handler's promise does. A synchronous wait inside `handleUri` would block
the extension host and therefore the focus.

The design follows from that:

- `handleUri` returns `void` immediately. It schedules a detached task and never returns or
  awaits a promise that waits for focus. (VS Code would ignore such a promise anyway, but the
  design doesn't rely on that.)
- The task validates and claims the request, calls `terminal.show(false)`, records `shownAt`,
  then waits up to 1.5 s for `window.state.focused` to be true at or after `shownAt`. A focus
  seen before the request doesn't count: Hoku was frontmost at click time, so any focus after
  `shownAt` is new.
- The reply carries `focusedAt`, or `null` on timeout. Hoku never claims precise success without
  it.

`windowId` routing and the force-focus are VS Code behaviour, not a documented contract. If
they change, replies stop confirming focus and Hoku degrades to the honest fallback.

## Threat model

Other processes running as the same user can already act as the user, so the boundary that
matters is other users and web content.

| Threat | Mitigation |
|---|---|
| A web page opens a forged `vscode://joao-afonso-p.hoku-vscode/focus` link | VS Code's trust dialog applies. Even when trusted, the URI carries only an id; without a fresh, user-owned request file that Hoku wrote, the handler replies `expired` and does nothing else. The worst a valid request can do is show a terminal. |
| A malicious or garbled record or reply reaches Hoku | Strict file checks (regular file, owner, size, schema, numeric fields). The URL is rebuilt from digits and hex and checked with a strict regex; the scheme comes from Hoku's own `ps` analysis, never from a record. |
| PID reuse | Claude-pid and extension-host start-time guards; terminal pids re-checked live at click time. |
| Remote PIDs colliding with local ones | Remote windows publish no PIDs. |
| Replaying or confusing an earlier click | A fresh random id per click, a single-use claim rename, Hoku-side deletion, and reply binding on id, kind, window and extension host. Replies are only read by exact id. |
| Leaking personal data | Only PIDs, a window number, versions, timestamps and status words. No terminal names or contents, file names, workspace paths or cwd. Folders 0700, files 0600, short-lived. Nothing goes into `hub.sqlite`. |
| Network | Neither side makes network requests or listens on a port; the CSP is unchanged. Install runs VS Code's own CLI from its app bundle with a VSIX shipped inside Hoku.app. |
| Weakening Hoku | No Accessibility permission, no Apple Events to VS Code, no VS Code settings written, no access to other processes' environments, and `~/.claude/ide/*.lock` (which holds tokens) is never read. |

## Packaging

- `pnpm vscode:package` (`scripts/package-vscode-extension.mjs`) cleans
  `extensions/vscode/out/`, compiles with `extensions/vscode/tsconfig.build.json` (which excludes
  `*.test.ts`), and runs `vsce package --no-dependencies` (offline) to write
  `src-tauri/resources/vscode/hoku-vscode.vsix`. `pnpm vscode:build` only compiles.
  `extensions/vscode/.vscodeignore` keeps the VSIX to `out/`, `package.json`, `README.md` and
  `LICENSE`.
- `src-tauri/tauri.conf.json`: `beforeBuildCommand` is `pnpm build && pnpm vscode:package`,
  and `bundle.resources` maps `resources/vscode/*` to `vscode/`, so the VSIX lands at
  `Hoku.app/Contents/Resources/vscode/hoku-vscode.vsix`. The folder keeps a tracked `README.md`
  so the glob always matches, and `cargo test` and `pnpm tauri dev` work without packaging
  first. `*.vsix` and `extensions/vscode/out/` are gitignored.
- Hoku resolves the VSIX with `app.path().resolve("vscode/hoku-vscode.vsix",
  BaseDirectory::Resource)`. A build without it says "This build of Hoku doesn't include the VS
  Code extension."
- `scripts/verify-macos-release.sh` fails unless the app contains the VSIX, it's a valid
  archive, and it includes `extension/out/extension.js`.
- CI runs `pnpm vscode:package` in the frontend job, and the debug app build packages it through
  `beforeBuildCommand`. `release.yml` is unchanged: the VSIX ships only inside Hoku.app.

When the extension changes, bump `version` in `extensions/vscode/package.json` and
`BUNDLED_EXTENSION_VERSION` together. The setup sheet offers **Update** when the installed
version is older than the bundled one.

## Testing

- **Extension** (`extensions/vscode/src/bridge.test.ts`, vitest, part of `pnpm test`): record
  building (exited and remote terminals excluded, no names), atomic 0600 writes, URI parsing,
  request claiming (freshness, ownership, symlinks, size, id format, `windowId` mismatch,
  single use, the longer ping age), private folders that refuse symlinks, reply statuses,
  superseded requests (a newer click in the same window wins; the older one never reports
  focus or shows a late terminal), the debounced publisher, and the A1 ordering with a fake
  host:
  `handleUri` returns a non-thenable before any focus and before any reply exists; focus fired
  afterwards yields `shownAt ≤ focusedAt`; a pessimistic host that awaits the return value
  doesn't hang; focus that never comes gives `focusedAt: null`; stale focus from before
  `shownAt` doesn't count.
- **Rust** (`#[cfg(test)]` in `src-tauri/src/vscode_bridge.rs`, plus `launch.rs` and
  `commands.rs`; `cargo test`): anchors from inline `ps` strings, record validation, every
  `plan` variant and guard, the attempt flow with a recording fake `Desktop` (success opens
  exactly one `open -g` URL and leaves no files; leftover replies from another click are
  ignored; every rejection rule, including `superseded`; Spaces), the URL validator against
  injection attempts, file modes, the exhaustive outcome → `OpenResult` table (only the
  precise rows are `exact` and say "Switched to this session's terminal"; only they and
  `superseded` have `activate == None`), the open generation that keeps an older click from
  activating over a newer one, garbage collection before focus and setup, the CLI timeout
  killing the whole process group, the install argument builder, version parsing, status
  assembly and the ping flow.
- **Frontend** (vitest): the status-line helper and `routeOpenResult` toast and sheet routing
  (success only for `exact` results).
- Tests never call the real `open`, `ps` or `code`, and never touch a real VS Code profile.

### Manual testing

Never send URLs to, install into, or reconfigure the VS Code you work in. Use an isolated
instance: `code --user-data-dir <tmp> --extensions-dir <tmp>`, and run any Hoku debug build
against a throwaway `HOME`. Things worth checking by hand: two windows with the session in the
background one; another terminal selected; the extension uninstalled; a fresh profile (trust
dialog, then **Allow Hoku in VS Code**); closing or reloading the window mid-click; the Spaces
setting off; a Remote-SSH window; iTerm, Terminal and `claude attach` regressions.

## Publishing later (not done)

The extension is deliberately not published. If that changes:

- **Visual Studio Marketplace.** Create (or use) the publisher `joao-afonso-p` in the
  Marketplace management portal, create an Azure DevOps personal access token with the
  Marketplace "Manage" scope, then from `extensions/vscode/`:
  `vsce login joao-afonso-p` and `vsce publish` (or `vsce publish --packagePath <vsix>` to
  publish the exact VSIX Hoku bundles). `"private": true` in `package.json` only affects npm.
- **Open VSX.** Claim the `joao-afonso-p` namespace with an Open VSX token, then
  `npx ovsx create-namespace joao-afonso-p` (once) and `npx ovsx publish <vsix> -p <token>`.
- **The extension ID must not change.** `joao-afonso-p.hoku-vscode` is the URI authority Hoku
  opens, the id it looks for in `code --list-extensions`, and the id users trust in VS Code's
  dialog. Renaming the publisher or name would break navigation and trust for every install.
- Keep the bundled VSIX as the default install path either way, so Hoku keeps working offline,
  and keep Marketplace and bundled versions in step.
- Tokens never go in the repository or in CI logs.
