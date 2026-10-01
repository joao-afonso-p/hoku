# Security Policy

## Supported versions

Hoku is pre-1.0. Security fixes go to the latest `main` and the next release only.

| Version | Supported |
|---|---|
| latest `main` | Yes |
| 0.1.x (latest release) | Yes |
| anything older | No |

## Reporting a vulnerability

**Please don't open a public issue, discussion or PR for a security problem.**

Report it privately through GitHub's private vulnerability reporting: open the
repository's **Security** tab and click **Report a vulnerability**, or go directly to
<https://github.com/joao-afonso-p/hoku/security/advisories/new>.

(Maintainer note: this form only works while private vulnerability reporting is enabled
under *Settings → Code security → Private vulnerability reporting*.
`scripts/github-setup.sh` enables it and creates the issue labels.)

If the form isn't available, contact the maintainer
[@joao-afonso-p](https://github.com/joao-afonso-p) privately through GitHub. If that
isn't possible either, open a public issue that only asks for a private contact, with no
details.

Please include:

- the affected version or commit, and your macOS version
- what an attacker controls (for example a crafted file in a provider store, a malicious
  deep link, or a session id)
- steps to reproduce, ideally with a **synthetic** proof of concept
- the impact you expect

**Don't include personal data.** Leave out real session titles, prompts or transcripts,
account emails, tokens, and paths that contain your username. Use made-up fixtures that
reproduce the problem.

Hoku is maintained by one person in their spare time. Expect an acknowledgement within
about a week. Fixes are coordinated with the reporter before anything is disclosed, and
you're credited in the advisory unless you'd rather not be.

## Security model

- **Local only.** There's no account, backend, telemetry or analytics, and Hoku makes no
  network requests itself. It runs the providers' CLIs (`claude auth status`,
  `codex login status`, `--version`), which may contact their own servers. The production
  CSP in `src-tauri/tauri.conf.json` restricts the webview to its own assets and Tauri IPC;
  `devCsp` also allows the Vite dev-server websocket (`ws://localhost:1420`).
- **Provider data is read-only.** Claude Code (`~/.claude`), Codex (`~/.codex`) and
  Claude Desktop (`~/Library/Application Support/Claude/...` on macOS,
  `~/.config/Claude/...` on Linux) data is read, never
  written. Foreign SQLite databases are opened with `SQLITE_OPEN_READ_ONLY` and
  `PRAGMA query_only`. The only database Hoku writes is its own index:
  `~/Library/Application Support/com.hoku.app/hub.sqlite` on macOS, or
  `$XDG_DATA_HOME/com.hoku.app/hub.sqlite` on Linux.
- **No credentials.** Token and credential files are never opened. Account state comes
  only from `claude auth status` and `codex login status`, and only non-secret fields
  are kept.
- **Minimal content.** Full transcripts are never stored. Per session the index keeps a
  title, a first-prompt preview of at most 200 characters, a runtime detail of at most 160
  characters, and metadata (paths, branch, PR link, model, token count). Account labels can
  include the email `claude auth status` reports. Credentials in git origin URLs are
  stripped before storage.
- **Launching.** `src-tauri/src/launch.rs` validates session ids
  (`^[A-Za-z0-9][A-Za-z0-9_-]{5,79}$`, so an id can't be a flag), requires existing absolute directories, shell-quotes paths
  and escapes AppleScript strings. `open` / `xdg-open` is limited to `claude://`, `codex://`,
  `https://claude.ai/` and `https://chatgpt.com/`. On Linux the resumed command is a single
  `bash -lc` argument.
- **macOS Automation permission.** Switching to or opening a Claude Code terminal on macOS uses
  AppleScript to control iTerm or Terminal. macOS asks for Automation permission once,
  and you can revoke it in System Settings → Privacy & Security → Automation. Linux starts
  the installed terminal emulator directly and does not use AppleScript.
- **Releases.** Release builds are ad-hoc signed and not notarized by Apple (Hoku isn't in
  the paid Apple Developer Program). Each release publishes `SHA256SUMS.txt` and a GitHub
  build provenance attestation (`gh attestation verify <dmg> --repo joao-afonso-p/hoku`).
  `scripts/install.sh` checks the checksum before installing. See
  [docs/releasing.md](docs/releasing.md).
- **Debug-only devtools.** Debug builds open a localhost control socket
  (`src-tauri/src/devtools.rs`) that is compiled out of release builds. It is
  unauthenticated, so any local process can drive a running dev build.

## In scope

- Any write, lock, move or delete in a provider store (`~/.claude`, `~/.codex`, Claude
  Desktop's support folders), or a way to trigger one
- Reading credential or token files, or persisting or exposing secrets
- Command, shell or AppleScript injection through session ids, working directories,
  titles or other provider-controlled data in the launch paths
- Opening unexpected URLs or schemes, and deep-link parsing issues (manual "Add session"
  references, `claude://` or `codex://` links)
- Persisting or leaking transcript content beyond the title and short preview
- CSP bypasses, script injection into the webview, or misuse of the IPC commands
- The devtools socket being reachable in a release build or from off-host
- `scripts/install-local.sh` touching user data it shouldn't
- The release workflow (`.github/workflows/release.yml`) publishing artifacts that weren't
  built and verified by it, or `scripts/install.sh` installing something other than the
  checksum-verified release, or touching user data

## Out of scope

- Attacks that already need full control of the user account (for example an attacker
  who can already write to `~/Library` or run code as the user), unless Hoku makes them
  meaningfully worse
- Vulnerabilities in Claude Code, Codex, Claude Desktop, iTerm or macOS themselves.
  Report those to their vendors.
- Running Hoku on unsupported platforms (anything other than macOS)
