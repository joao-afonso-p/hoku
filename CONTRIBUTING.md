# Contributing to Hoku

Thanks for your interest in Hoku. This guide covers what you need to build it, how the
provider adapters fit together, the rules every change has to follow, and what a pull
request should look like.

By participating you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). To report
a security problem, see [SECURITY.md](SECURITY.md). Don't open a public issue for it.

## Supported platform

Hoku runs on **macOS only**.

- No minimum macOS version is pinned in `src-tauri/tauri.conf.json`. Development and
  testing happen on current macOS releases (the provider investigation in
  [docs/provider-discovery.md](docs/provider-discovery.md) was done on macOS 26). Some
  behaviour is version-aware. For example, `launch::yield_to` uses the cooperative
  activation API that macOS 14 introduced, and only when the running macOS supports it.
  Please include your macOS version in bug reports.
- **Linux and Windows are not supported.** The Rust side calls AppKit through `objc2`,
  drives iTerm and Terminal with AppleScript (`osascript`), and reads macOS-specific paths
  such as `~/Library/Application Support`. Some of this is `cfg`-gated, so parts of the
  crate may compile elsewhere, but the app isn't expected to work on another OS today. If
  you're interested in porting it, open an issue with the **Platform support** template
  first so we can discuss the approach before you write code.

## Prerequisites

- macOS
- Xcode Command Line Tools: `xcode-select --install`
- Node.js 22.12+ (Vitest 5 and Vite 8 require it; see `engines` in `package.json`)
- pnpm
- Rust stable, installed with [rustup](https://rustup.rs)

## Setup and development

```bash
pnpm install
pnpm tauri dev      # runs Vite on :1420 and the Tauri app in debug mode
```

Other useful commands:

```bash
pnpm dev                      # frontend only, in a browser (no Rust backend, IPC calls fail)
pnpm build                    # typecheck + production frontend build into dist/
pnpm tauri build --no-bundle  # release build of the Rust app without creating Hoku.app
pnpm install:local            # build and install /Applications/Hoku.app (see README)
```

Debug builds start a localhost-only control socket (`src-tauri/src/devtools.rs`, port
47831) that's used to inspect the UI during development. It's compiled out of release
builds. The socket is unauthenticated, so while `pnpm tauri dev` runs any local process can
drive the webview. Don't run dev builds on a shared machine.

Hoku's own index lives in `~/Library/Application Support/com.hoku.app/hub.sqlite`, and
`pnpm tauri dev` uses that same file. To test against a clean state, move the folder
aside temporarily. **Settings → Load demo** adds clearly labelled demo data, which
**Remove demo data** deletes again.

## Repository layout

```
src/                      React 19 + TypeScript + Tailwind v4 UI
  providers/index.ts      provider UI descriptors (label, glyph, accent, open wording)
  lib/types.ts            TS mirror of the Rust models (camelCase)
  lib/api.ts              typed wrappers around Tauri `invoke`
  features/               galaxy, constellation, runtime, sessions, scan, integrations, ...
src-tauri/src/            Rust: all I/O
  providers/              one adapter per provider source (read-only)
  scan.rs                 runs adapters, merges results into the hub DB
  runtime.rs              runtime monitor (4 s tick, watchdog, activity events)
  attention.rs            Needs You notifications, Dock badge and bounce
  launch.rs               opening sessions: deep links, terminals via AppleScript
  integrations.rs         installed apps/CLIs, sign-in status, capability table
  db.rs                   Hoku's own SQLite: schema, migrations, merge rules
  commands.rs             the IPC surface
docs/                     architecture, provider discovery, runtime state, layout
```

[docs/architecture.md](docs/architecture.md) has the full picture.

## Provider adapter architecture

A *provider* is a vendor surface, defined by the `Provider` enum in
`src-tauri/src/models.rs`: `ClaudeCode`, `Claude` (Claude Desktop) and `Codex`. An
*adapter* is one read-only data source for a provider. One provider can have several
sources. For example, Claude Desktop Cowork sessions come from `CoworkAdapter`, while
Claude chats have no adapter at all because they're manual-only.

### Rust side

Adapters live in `src-tauri/src/providers/`:

| File | Adapter | Key (`sessions.source`) | Provider |
|---|---|---|---|
| `claude_code.rs` | `ClaudeCodeAdapter` | `claude-code-transcripts` | `ClaudeCode` |
| `codex.rs` | `CodexAdapter` | `codex-state-db` | `Codex` |
| `claude_desktop.rs` | `CoworkAdapter` | `claude-cowork` | `Claude` |
| `text.rs` | helpers: `title_from_prompt`, `preview` (≤200 chars), `truncate`, `is_noise_prompt` | | |

`src-tauri/src/providers/mod.rs` defines the `SessionAdapter` trait:

```rust
pub trait SessionAdapter: Send + Sync {
    fn key(&self) -> &'static str;          // stable, stored as sessions.source
    fn provider(&self) -> Provider;
    fn label(&self) -> &'static str;
    fn scan(&self) -> Result<ScanOutcome, HubError>;          // Found(Vec<DiscoveredSession>) | Unavailable(msg)
    fn project_hints(&self) -> Vec<ProjectHint> { .. }        // default: none
    fn owns_runtime(&self, s: &Session) -> bool { .. }        // default: same provider
    fn runtime(&self, targets: &[RuntimeTarget]) -> Option<RuntimeProbe> { .. } // default: None
    fn runtime_capabilities(&self) -> RuntimeCapabilities { .. }                // default: none
}
```

`all_adapters()` in the same file builds the list, rooted at the real home directory. The
app gets it through `commands::default_adapters()`.

`mod.rs` also has shared helpers: `read_tail` (the last N bytes of a large file),
`file_stamp`, `app_running` (cached `pgrep`), `pid_alive` (`kill(pid, 0)`), `ms_to_iso`,
`now_ms` and `system_time_iso`.

A provider integration has four responsibilities. Only the first two live in the adapter.

1. **Discovery.** `scan()` reads the provider's local store and returns normalized
   `DiscoveredSession`s (`models.rs`). These carry the external id, a title, the working
   directory and repository, the branch, the deep link, the last activity, an optional
   `account_hint`, and a small `metadata` map. If the store isn't on this Mac, `scan()`
   returns `ScanOutcome::Unavailable`, which isn't an error. `scan::run_scan` calls every
   adapter (or a subset by key) without holding the DB lock. Then `scan::merge` upserts
   the results with `db::upsert_discovered`, which never overwrites user intent such as a
   locked title, a locked project or notes, and flags vanished sessions with
   `db::flag_missing` instead of deleting them. `project_hints()` feeds project
   suggestions.
2. **Runtime state.** `runtime::tick` runs every 4 s. For each adapter it collects the
   sessions it `owns_runtime`, calls `runtime(&[RuntimeTarget])`, and gets back a
   `RuntimeProbe`: per-id `Observation`s, a `fallback` for owned sessions it didn't
   mention, and `unindexed_live` ids that trigger a quick discovery scoped to that
   adapter. The monitor then applies the watchdog rules (`runtime::settle`), diffs, writes
   and records activity events. Build observations with
   `Observation::new(state, confidence, source)` and the builder methods (`.reason()`,
   `.detail()`, `.since()`, `.activity()`, `.action()`). `runtime_capabilities()` states
   honestly what the source can report ("full", "partial", "limited" or "none"). See
   [docs/runtime-state.md](docs/runtime-state.md).
3. **Opening and launch.** This is *not* in the adapter. `launch::open_session` matches on
   `session.provider` and dispatches to `open_claude_code`, `open_codex` or
   `open_claude`. Every value that reaches a shell or AppleScript goes through
   `launch::validate_id` (`^[A-Za-z0-9][A-Za-z0-9_-]{5,79}$`), `shell_quote` or `applescript_string`.
   Directories are checked with `existing_dir`. URLs go through `open_url`, which only
   accepts the prefixes in `allowed_url`. Manual "Add session" references are parsed per
   provider in `commands::parse_reference_inner`.
4. **Account status and integrations.** `integrations::detect` builds the Integrations
   view: installed apps and CLIs, an account state that comes **only** from official
   status commands (`parse_claude_auth` for `claude auth status`, `parse_codex_login` for
   `codex login status`), and a `Capability` row per adapter key.

### Frontend side

The UI has no provider logic beyond presentation:

- `src/lib/types.ts`: the `Provider` union (`"claude-code" | "claude" | "codex"`) and the
  `Session` type, which mirror `models.rs`.
- `src/providers/index.ts`: `PROVIDERS` (a `ProviderDescriptor` per provider with label,
  accent, `Glyph`, sector `order` and manual-add placeholders), `surfaceLabel`,
  `openDescription`, `openHint` and `ADAPTER_LABELS` (adapter key to display name).
- A few views name providers directly: `src/features/scan/ScanSheet.tsx` (the list of
  what a scan reads) and `src/features/integrations/IntegrationCenter.tsx` (Claude and
  Codex account groups).

## Non-negotiable rules

These rules are the reason Hoku can be trusted with someone's machine. A PR that breaks
any of them won't be merged.

1. **Provider stores are read-only.** Never create, modify, lock, move or delete anything
   under `~/.claude`, `~/.codex`, `~/Library/Application Support/Claude`, or any other
   provider's data. Open foreign SQLite databases with `SQLITE_OPEN_READ_ONLY` and
   `PRAGMA query_only` (see `CodexAdapter::open_ro` and its `never_writes_to_the_codex_db`
   test). Don't acquire the provider's lock files or run migrations on its databases. The
   only database Hoku writes is its own `hub.sqlite`.
2. **Never read credentials or tokens.** Don't open files like `~/.codex/auth.json`,
   `~/.claude/sessions/*.key`, `~/.claude/daemon/auth`, or Claude Desktop's OAuth or config
   caches, even to read one "harmless" field. Account state comes only from a provider's
   official CLI status command, and only its non-secret fields are parsed
   (`claude_auth_reads_only_public_fields` shows the pattern).
3. **Index titles and short previews only.** Store a title (≤64 characters via
   `text::truncate` or `text::title_from_prompt`) and at most a ≤200-character first-prompt
   preview (`text::preview`). Never store full transcripts, tool output, system prompts or
   file contents. Runtime `detail` is capped at 160 characters by `Observation::detail`.
   Reading a transcript *tail* in memory to derive state is fine, but persisting it isn't.
4. **No network.** Hoku has no backend, telemetry or analytics. Don't add HTTP clients,
   remote fonts or scripts, or loosen the CSP in `tauri.conf.json`. The only exception is
   the opt-in, click-to-generate Project Resume AI draft (`src-tauri/src/resume.rs`). It
   goes through the user's installed Claude Code CLI with an inspectable, scrubbed payload.
   Don't widen what it sends, and don't make it automatic (see
   [docs/architecture.md](docs/architecture.md#optional-ai-drafts-resumers)).
5. **Launch paths are an injection surface.** Anything from a provider store is untrusted
   input. Validate ids, quote paths, escape AppleScript, and add a URL prefix to
   `allowed_url` only when a new scheme is really needed, with a test.
6. **Tests use fixtures and temp dirs, never real data.** Build a fake store in a
   `tempfile::tempdir()` (see `codex.rs` `fixture()` and the tests in `claude_code.rs`) or
   use inline JSON/JSONL strings. Frontend tests use `src/test/fixtures.ts`. Don't commit
   anything copied from your own `~/.claude`, `~/.codex` or Claude Desktop folders, even
   "just the schema" with real values in it.
7. **Be honest about uncertainty.** If a source can't know a state, report `Unknown` or a
   lower `Confidence` rather than guessing. An adapter must never put a session in Needs
   You unless the provider actually signals it.

## Adding a new provider

First open an issue with the **Provider integration** template. It asks where the data
lives, how it can be read without writing, and how sessions can be reopened. Agreeing on
that before you write code saves a lot of rework.

**A) A new source for an existing provider** (like Cowork under `Claude`):

1. Create `src-tauri/src/providers/<name>.rs` with a struct holding its root path
   (`pub fn new(root: PathBuf) -> Self`) and `impl SessionAdapter`. Pick a new, stable
   `key()`, because it's persisted in `sessions.source` and must never change.
2. Implement `scan()`. Return `ScanOutcome::Unavailable` when the store is missing, and
   build `DiscoveredSession`s using the `text` helpers for titles and previews. Use
   `association::repository_root` for the repository, as the other adapters do.
3. If the source has live signals, implement `runtime()` and `runtime_capabilities()`. Keep
   the probe cheap: it runs every 4 s. Prefer mtimes, `read_tail` and cached checks. If
   another adapter of the same provider already claims these sessions, override
   `owns_runtime()` (see `CoworkAdapter::owns_runtime`).
4. Register it: `pub mod <name>;` and an entry in `all_adapters()` in
   `src-tauri/src/providers/mod.rs`.
5. Add a `Capability` for the new key to the right `ProviderGroup` in
   `integrations::detect`, and an `ADAPTER_LABELS` entry in `src/providers/index.ts`.
6. Add tests in a `#[cfg(test)] mod tests` block, using a tempdir fixture and covering at
   least parsing, filtering, the missing-store case and the runtime mapping.

**B) A brand-new provider.** Do everything in A, plus:

1. Add a variant to `Provider` in `src-tauri/src/models.rs` and update `as_str`, `parse`
   and `account_provider`.
2. Add a migration to `MIGRATIONS` in `src-tauri/src/db.rs`. The `sessions.provider` and
   `provider_accounts.provider` columns have `CHECK (provider IN (...))` constraints, so
   SQLite needs a table rebuild. Existing rows must survive: follow
   `migrates_a_v1_database_without_losing_rows`.
3. Add an arm to `launch::open_session` with an `open_<provider>` function. Use a
   documented deep link where one exists, otherwise a validated CLI command in the
   terminal. Add the scheme to `allowed_url` with a test.
4. Add an arm to `commands::parse_reference_inner` so sessions can be added by hand.
5. Add a `ProviderGroup` in `integrations::detect`. If the provider has an account, read
   its state only from an official status command and parse only non-secret fields.
6. Frontend: extend the `Provider` union in `src/lib/types.ts`, then add a `PROVIDERS`
   descriptor (and a `Glyph` if needed) and cases in `openDescription` and `surfaceLabel`
   in `src/providers/index.ts`. Also update `ScanSheet.tsx` and `IntegrationCenter.tsx`.
   `pnpm typecheck` flags the exhaustive `switch`es you missed.
7. Document the investigation in `docs/provider-discovery.md` (with redacted examples)
   and the signals in `docs/runtime-state.md`, and update the Providers table in
   `README.md` and the provider pages of the user guide (`site/src/content/docs/providers/`).

## Validation before opening a PR

Run all of these and make sure they pass:

```bash
pnpm typecheck
pnpm test
pnpm build
(cd src-tauri && cargo fmt --check && cargo test)
pnpm tauri build --debug --bundles app   # unsigned app build, same as CI
```

There are also `#[ignore]`d manual probes. They're optional and not part of CI:

- `cd src-tauri && cargo test probe_this_mac -- --ignored --nocapture` scans **your real**
  provider data into an in-memory hub and prints runtime states, titles and events. It
  writes nothing to disk, but its output contains your session titles and details.
  **Never paste it verbatim into an issue or PR.** Summarize it, or redact titles, paths,
  prompts and emails first.
- `launch.rs` has `probe_window_space` (`HOKU_WINDOW_IDS=... cargo test probe_window_space -- --ignored --nocapture`)
  for checking desktop (Space) detection.

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/) prefixes, as in the
  existing history: `feat:`, `fix:`, `docs:`, `chore:`, `style:`, and `refactor:` or
  `test:` where they fit. Write short, imperative, lowercase summaries, for example
  `fix: keep session titles visible next to long branch names`.
- Keep each PR focused on one change. Explain *why*, not only what, and link the issue.
- Update the docs (`README.md`, `docs/`) when you change behaviour, provider integrations
  or the security model, and the [user guide](#user-guide-site) for anything users see.
- UI changes: include a before/after screenshot **with demo data** (Settings → Load
  demo), not your real sessions.
- Fill in the PR template checklist, including the macOS version you tested on.

Releases are cut by the maintainer from `v*` tags on `main`. A GitHub Actions workflow builds
the DMG and drafts the GitHub Release. See [docs/releasing.md](docs/releasing.md).

## User guide (`site/`)

The user guide at <https://joao-afonso-p.github.io/hoku/> is an Astro + Starlight site in
`site/`, separate from the app: its own `package.json` and lockfile, and a separate
[`docs.yml`](.github/workflows/docs.yml) workflow that builds it on pull requests and
deploys it from `main`. [site/README.md](site/README.md) covers running it locally.

- **User-facing change → user guide change, in the same PR.** A new feature gets a section
  or page. A changed label, shortcut, default or limitation gets its text updated. Write
  for users: what it does, how to use it, what it doesn't do.
- **Screenshots are real and use made-up data only.** `pnpm capture` (in `site/`) takes
  them from a debug build running against a throwaway home folder with demo or invented
  data, and writes them to `docs/images/`. Never add mockups or screenshots of your real
  sessions, and review every image before committing it.
- `docs/` stays the contributor documentation. Link to it from the guide for deep dives
  instead of copying implementation detail.

## Privacy in issues, PRs and fixtures

Hoku handles personal work data. In anything you post or commit, never include:

- real session titles, prompts, transcript excerpts or Codex thread names
- paths that contain your username (`/Users/yourname/...`). Use `/Users/me/...` or
  `/nonexistent/...`
- account emails, organization names, session/thread ids from your machine, or tokens
- screenshots that show real sessions or projects

Redact first. If you're not sure whether something is sensitive, leave it out and
describe it instead.

## License

By contributing, you agree that your contributions are licensed under the project's
[MIT License](LICENSE).
