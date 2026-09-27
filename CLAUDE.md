# CLAUDE.md

Repository guidance for Claude Code. [CONTRIBUTING.md](CONTRIBUTING.md) is the source of
truth for the rules below; read it before non-trivial changes.

## What Hoku is

A local-first macOS app that indexes Claude Code, Codex and Claude Desktop sessions
**read-only**, shows them as projects → sessions on a constellation map, and reopens each
session in its native tool. It does not replace those tools.

**macOS only.** The Rust side uses AppKit/WebKit through `objc2`, Tauri's
`macos-private-api`, AppleScript (`osascript`) for iTerm/Terminal, and macOS paths. Don't
add Linux or Windows code paths, CI jobs or packaging.

## Architecture

Tauri 2 (Rust) + React 19 + TypeScript + Tailwind v4 + SQLite (rusqlite, bundled).

- `src-tauri/src/`: all I/O. `commands.rs` (IPC surface), `db.rs` (Hoku's own SQLite:
  schema, ordered `MIGRATIONS` tracked by `PRAGMA user_version`, merge rules), `scan.rs`,
  `runtime.rs` (4 s monitor + watchdog), `launch.rs` (deep links, terminals),
  `integrations.rs`, `providers/` (one read-only adapter per source).
- `src/`: presentation only. `lib/types.ts` mirrors the Rust models, `lib/api.ts` wraps
  `invoke`, `providers/index.ts` holds provider UI descriptors, `features/` holds views.
- Bundle identifier `com.hoku.app` (never change it: the index location depends on it).
  The index is `~/Library/Application Support/com.hoku.app/hub.sqlite`, outside the app
  bundle.

Details: [docs/architecture.md](docs/architecture.md),
[docs/provider-discovery.md](docs/provider-discovery.md),
[docs/runtime-state.md](docs/runtime-state.md).

## Provider-adapter extension points

- Discovery and runtime state: implement `SessionAdapter` (`src-tauri/src/providers/mod.rs`)
  in a new `providers/<name>.rs` and register it in `all_adapters()`. `key()` is persisted
  in `sessions.source` and must never change.
- Opening: `launch::open_session` (per-provider `open_*`) and `allowed_url`.
- Manual "Add session": `commands::parse_reference_inner`.
- Account status and capabilities: `integrations::detect`.
- A brand-new provider also needs a `Provider` variant in `models.rs`, a table-rebuild
  migration in `db.rs` (the `CHECK (provider IN ...)` constraints), and frontend updates in
  `src/lib/types.ts` and `src/providers/index.ts`.

Follow "Adding a new provider" in CONTRIBUTING.md step by step.

## Local-first and privacy constraints (non-negotiable)

- Provider stores (`~/.claude`, `~/.codex`, `~/Library/Application Support/Claude`) are
  read-only: never write, lock, move or migrate them. Open foreign SQLite with
  `SQLITE_OPEN_READ_ONLY` and `PRAGMA query_only`. Hoku writes only its own `hub.sqlite`.
- Never open credential or token files. Account state comes only from `claude auth status`
  and `codex login status`, parsing non-secret fields.
- Store titles (≤64 chars), a ≤200-char preview and ≤160-char runtime detail only. Never
  persist transcripts, tool output or file contents.
- No network: no HTTP clients, telemetry, analytics, remote assets, or CSP loosening.
- Everything from a provider store is untrusted input to the launch paths: validate ids,
  shell-quote paths, escape AppleScript.
- Migrations must keep existing rows (see `migrates_a_v1_database_without_losing_rows`).

## Never touch real user data

Do not inspect, modify, copy, commit or paste real session databases or transcripts
(Hoku's `hub.sqlite` or any provider store), credentials, tokens, account emails, real
session/thread ids, or paths containing a username. Tests use `tempfile::tempdir()`
fixtures, inline strings, or `src/test/fixtures.ts`. Don't run the `#[ignore]`d probes
(`probe_this_mac`, `probe_window_space`) unless the maintainer asks; their output contains
real session data.

## Validation

```bash
pnpm typecheck
pnpm test
pnpm build
(cd src-tauri && cargo fmt --check && cargo test)
pnpm tauri build --debug --bundles app   # unsigned app build, same as CI
```

## `pnpm install:local` is not a build command

It builds a release, quits the running Hoku, and replaces `/Applications/Hoku.app` on
this machine. Don't run it as part of routine validation; use it only when the maintainer
explicitly wants the installed app updated. Use `pnpm tauri dev` or the unsigned debug
build above instead. The same applies to `scripts/install.sh` (the release installer).

## Git workflow

- Never commit or push directly to `main`; work on a branch and open a pull request.
- Conventional Commits (`feat:`, `fix:`, `docs:`, `ci:`, `chore:`, `refactor:`, `test:`),
  short imperative lowercase summaries, one focused change per PR.
- Don't push, tag, or create GitHub Releases unless asked. Releases are cut from `v*` tags
  on `main` by `.github/workflows/release.yml`; see [docs/releasing.md](docs/releasing.md).
- Never commit signing certificates, API keys, `.env` files or `*.sqlite`/`*.db` files.
