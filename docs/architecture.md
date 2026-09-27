# Architecture

Hoku is a Tauri 2 app. The Rust side owns every piece of I/O: the hub's SQLite
database, read-only provider discovery, launching terminals and deep links. The React side
owns presentation: the constellation, palette, inspector and sheets. They talk through a
small typed IPC surface.

```
┌──────────────────────── React (src/) ────────────────────────┐
│ app/        App shell, store (useSyncExternalStore), actions │
│ features/   constellation · galaxy · runtime · sessions ·    │
│             command-palette · projects · activity · recaps · │
│             scan · integrations · settings · onboarding      │
│ providers/  UI descriptors only (label, glyph, accent)       │
│ lib/        api.ts (typed invoke), types, hash, time, paths  │
└──────────────────────────────┬───────────────────────────────┘
                               │ tauri invoke (commands.rs)
┌──────────────────────── Rust (src-tauri/src/) ───────────────┐
│ commands.rs     IPC: validate → delegate → HubError          │
│ db.rs           our SQLite: schema, migrations, CRUD, upsert │
│ scan.rs         run adapters, merge, suggestions             │
│ runtime.rs      runtime monitor: state, watchdog, events     │
│ association.rs  cwd/repo → project; git worktree resolution  │
│ recap.rs        recaps: bounded period query, outcomes, PNG  │
│ providers/      claude_code · codex · claude_desktop (+text) │
│ launch.rs       terminals (AppleScript), deep links, pbcopy  │
│ integrations.rs installed apps/CLIs, sign-in status          │
│ devtools.rs     debug builds only: snapshot/eval socket      │
└──────────────────────────────────────────────────────────────┘
```

## Data

The only database written is `~/Library/Application Support/com.hoku.app/hub.sqlite`
(WAL). An index from the old identifier's folder (`com.aisessionhub.app`) is copied over once
on first launch; the old file is left as a backup. Migrations are an ordered list in `db.rs`, tracked with `PRAGMA user_version`.

| Table | Purpose |
|---|---|
| `projects` | name, optional root path, accent, **stable galaxy slot**, demo flag, `archived_at` (archived projects keep everything and restore in place) |
| `provider_accounts` | per-vendor account labels (`claude` / `codex`), auth mode, status. Labels only, never secrets |
| `sessions` | the index. `(provider, external_id)` is unique. User-owned flags: `favorite`, `notes`, `project_locked`, `title_locked`. `runtime_*` columns hold the normalized runtime status (monitor-owned) |
| `activity_events` | semantic runtime transitions for the Activity timeline (90 days) |
| `session_links` | optional undirected relationships |
| `recap_outcomes` | one-line milestones the user writes for recaps (text ≤140 chars, local date, optional project). Never inferred |
| `scan_runs` | per-adapter scan history (for "last scan") |
| `settings` | key → JSON (terminal preference, first-scan flag) |

### Merge rules (`db::upsert_discovered`)

A scan refreshes the provider-owned fields: path, branch, last activity, activity, metadata
and deep link. It **never overwrites user intent**:

- a renamed title (`title_locked`)
- an explicit project choice, including "Unsorted" (`project_locked`)
- any existing assignment
- notes, favorite, account

Sessions the provider no longer reports are flagged `source_missing`, never deleted.

### Project association (`association.rs`)

1. Explicit user choice, which is sticky.
2. Existing assignment.
3. The deepest project root that contains the session's repository root or working
   directory.

Repository roots resolve linked git worktrees (`.git` file → `gitdir: …/.git/worktrees/x` →
main repo) and strip agent worktree suffixes (`/.claude/worktrees/*`). As a result, a Claude
Code session in `backoffice/.claude/worktrees/proj-292` lands in the same project as the
repo. Creating or editing a project re-associates unassigned sessions.

## Provider adapters

```rust
trait SessionAdapter {
    fn key(&self) -> &'static str;          // also sessions.source
    fn provider(&self) -> Provider;
    fn label(&self) -> &'static str;          // shown in Integrations
    fn scan(&self) -> Result<ScanOutcome, HubError>;   // Found(..) | Unavailable(msg)
    fn project_hints(&self) -> Vec<ProjectHint>;       // e.g. Codex projects
    fn owns_runtime(&self, s: &Session) -> bool;                        // which sessions it observes
    fn runtime(&self, targets: &[RuntimeTarget]) -> Option<RuntimeProbe>; // cheap, read-only
    fn runtime_capabilities(&self) -> RuntimeCapabilities;              // shown in Integrations
}
```

Adapters are read-only and contain all provider-specific knowledge. Opening sessions lives
in `launch.rs`, keyed by provider. The UI only knows provider *descriptors* (label, glyph,
accent) and `openDescription()`.

Adding a *source* for an existing provider means one new adapter module registered in
`providers::all_adapters()`. Adding a new *provider* also needs a `Provider` variant
(`models.rs`) with a DB migration for the `CHECK (provider IN (...))` constraints, a
`launch.rs` branch, `commands::parse_reference_inner`, a row in `integrations.rs`, and on the
frontend the `Provider` union (`src/lib/types.ts`), its descriptor and `ADAPTER_LABELS`
(`src/providers/index.ts`), `ScanSheet.tsx` and `IntegrationCenter.tsx`. See
[CONTRIBUTING.md](../CONTRIBUTING.md).

## Threads and responsiveness

- Scans, integration detection and opening run on Tauri's blocking pool
  (`spawn_blocking`). Filesystem and foreign-DB work happens **without** holding the hub
  DB lock. The lock is taken only to merge.
- The runtime monitor (`runtime.rs`) runs on its own thread every 4 s. It probes providers
  without the DB lock, writes only what changed, and emits `hub://runtime`, and the UI
  reloads on that event. There's no UI polling. Regaining focus runs an immediate pass. New
  live sessions trigger an adapter-scoped discovery. Full scans stay manual (⌘⇧S). See
  [runtime-state.md](runtime-state.md).
- The constellation re-renders in screen space. Layouts are memoized per data change and
  per minute, and the camera animates with `requestAnimationFrame`.

## Galaxy visibility

`src/features/galaxy/visibility.ts` is the single definition of what the map shows:
Current (live + needs you + recent window + favorites) or All. The Galaxy, the drawers,
project counts and Tab-cycling all use it, so they can't disagree. Runtime *meaning* (Needs
You, priority, labels) lives in `src/features/runtime/status.ts`. Filtering (Galaxy status
filter, Sessions view) lives in `src/features/sessions/filter.ts`. The command palette
deliberately does not: search always covers every session. See
docs/constellation-layout.md.

## Frontend state

A single small store (`app/store.ts`) holds a snapshot of the DB (including recent activity
events) plus UI state: view (Galaxy / Sessions / Recaps), focus, selection, overlay, drawer (Needs
You / Activity / Favorites / Projects), status filter, Sessions filter and sort, toasts and
scan report. Mutations call the backend and then
reload the snapshot. The dataset is hundreds of rows, so this stays simple and consistent.

## Security

- External stores are opened `SQLITE_OPEN_READ_ONLY` plus `query_only`. There's a test
  asserting writes fail.
- Credential files are never opened (see docs/provider-discovery.md).
- Transcripts are never stored. Per session the index keeps a title, a ≤200-character
  first-prompt preview, a ≤160-character runtime detail (e.g. the pending question or
  approval reason), and metadata: working directory and file paths, branch, PR link, model,
  token count. Account labels can include the email reported by `claude auth status` or
  Cowork metadata. Credentials in git origin URLs are stripped before storage.
- `launch.rs` validates ids (`^[A-Za-z0-9][A-Za-z0-9_-]{5,79}$`, so an id can't be a flag), requires existing absolute
  directories, shell-quotes paths and escapes AppleScript strings. `open` is restricted to
  `claude://`, `codex://`, `https://claude.ai/` and `https://chatgpt.com/`.
- Recaps are shared only by the user: the share card is copied to the pasteboard or saved as
  a new PNG in `~/Downloads` (never overwriting a file), and its text is copied with `pbcopy`.
  Card content is built from aggregates and the user's own words only. See
  [recaps.md](recaps.md).
- Hoku makes no network requests and has no analytics or telemetry. It runs the providers'
  own CLIs (`claude auth status`, `codex login status`, `--version`), which may contact their
  servers. The production CSP allows only IPC; `devCsp` adds the Vite dev server's websocket.

## Development tooling

Debug builds start a localhost-only control socket (`devtools.rs`, port 47831). It can
evaluate JS and capture a WKWebView snapshot to PNG without Screen Recording permission.
This is how the UI was validated visually during development. It is compiled out of release
builds with `#[cfg(debug_assertions)]`. The socket is unauthenticated: while `pnpm tauri dev`
is running, any local process can drive the webview, so don't run dev builds on a shared
machine.
