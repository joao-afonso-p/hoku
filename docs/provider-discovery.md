# Provider discovery

Investigated September 2026 on macOS 26 (Apple Silicon). Versions and formats below are the
ones observed then; provider apps change their storage without notice.

Everything below was inspected **read-only**. SQLite databases were opened read-only
(`SQLITE_OPEN_READ_ONLY` plus `PRAGMA query_only`). No external file was modified (SQLite
readers still take shared locks and update read marks in a WAL database's `-shm` file, as any
reader does). Credential files (`~/.codex/auth.json`,
Claude Desktop `config.json` OAuth caches, `~/.claude/sessions/*.key`, `~/.claude/daemon/auth`)
were located but **not read**.

---

## 1. Installed software

| Component | Path | Version | Bundle id / notes |
|---|---|---|---|
| Claude Desktop | `/Applications/Claude.app` | 2.110.0 | `com.anthropic.claudefordesktop`, URL scheme `claude://` |
| Claude Code CLI | `~/.local/bin/claude` | 2.1.281 | Also registers `claude-cli://` via `~/Applications/Claude Code URL Handler.app` |
| Codex Desktop | `/Applications/ChatGPT.app` | 26.825.51511 | **Bundle id is `com.openai.codex`** – the app is named "ChatGPT.app" on disk but is the Codex desktop app. URL scheme `codex://` |
| Codex CLI | not on `PATH` | — | A bundled binary exists at `/Applications/ChatGPT.app/Contents/Resources/codex` (`codex-cli 0.151.0-alpha.7.2`) |
| iTerm2 | `/Applications/iTerm.app` | 3.7.1 | AppleScript-capable |
| Terminal.app | system | — | AppleScript-capable |

---

## 2. Claude Code

### Persistence

| Path | Content | Safe read-only? |
|---|---|---|
| `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl` | One transcript per session. Directory name is the cwd with `/` and `.` replaced by `-` (lossy – do not decode it, read `cwd` from records instead). | Yes (append-only files) |
| `~/.claude/sessions/<pid>.json` | **Live-session registry.** One file per running Claude Code process. | Yes |
| `~/.claude/sessions/<pid>.<hash>.key` | Secret material for the messaging socket. | **Not read** |
| `~/.claude/history.jsonl` | Prompt history. | Not needed |

Claude Code prunes old transcripts (`cleanupPeriodDays`).

### Transcript records (JSONL, one object per line)

Relevant record `type`s and fields:

- `user` / `assistant` – `sessionId`, `cwd`, `gitBranch`, `timestamp`, `version`, `message.content`
- `ai-title` – `aiTitle` (auto title)
- `custom-title` – `customTitle` (user-set via `/rename` or `--name`)
- `agent-name` – `agentName`
- `last-prompt` – `lastPrompt`
- `relocated` – `relocatedCwd` (session moved into a worktree)
- `worktree-state` – `worktreeSession.originalCwd`
- `pr-link` – PR metadata

Title precedence used by the adapter: **custom-title → agent-name → ai-title → first real user
message** (skipping `isMeta` lines and `<command-…>`/`<local-command-…>` wrappers).

### Live registry (`~/.claude/sessions/<pid>.json`)

```json
{"pid":12345,"sessionId":"<uuid>","cwd":"/Users/<you>/Projects/example","kind":"interactive" | "bg",
 "jobId":"<short-id>","name":"work session","status":"idle" | "busy" | "shell",
 "startedAt":…, "updatedAt":…, "version":"2.1.281"}
```

The file can outlive its process, so liveness is confirmed with `kill(pid, 0)`.
`claude agents --json` returns the same data for background sessions, but reading the files
directly is faster and needs no subprocess.

### Opening – verified against CLI help (2.1.281)

- `claude --resume <session-id>` – resume a stored conversation (run in the session's `cwd`).
- `claude attach <short-id>` – "Open a background session in this terminal. `<id>` is the short
  id that `claude --bg` prints". The short id is `jobId` in the registry.
- `claude stop <id>`: "`claude attach <id>` opens it again, `claude --resume` works once it
  is stopped". So attaching to a running background session is the right move, and resuming a
  live one is not.
- Running interactive sessions cannot be attached. Their controlling TTY is available
  (`ps -o tty= -p <pid>`), and both iTerm2 and Terminal.app expose a `tty` property on
  sessions/tabs through their official AppleScript dictionaries. So the terminal that already
  hosts the session can be **focused**. That requires macOS Automation permission the first
  time.

### MVP decision

- Scan transcripts and registry, both read-only.
- Open:
  1. Live background session: `claude attach <jobId>` in a new terminal window.
  2. Live interactive session: find its host by walking the process tree (one `ps -axo
     pid=,ppid=,comm=` snapshot). iTerm2/Terminal: focus the existing tab by TTY. VS Code
     (`com.microsoft.VSCode`) or VS Code Insiders (`com.microsoft.VSCodeInsiders`),
     recognised by the app bundle path or its `Code Helper` processes (the integrated
     terminal's pty host, or the extension host for extension-launched sessions): activate
     the app. VS Code exposes no way to select a terminal tab from outside, so the exact tab
     isn't selected. Forks (Cursor, VSCodium, Windsurf) and other Electron apps don't match.
     Anything else (Warp, tmux): explain, never start a second copy.
  3. Anything else: `cd <cwd> && claude --resume <id>` in a new terminal window.
- Runtime: the registry's `status` / `waitingFor` / `statusUpdatedAt` plus the transcript
  tail. See [runtime-state.md](runtime-state.md). Verified: a background session
  asking to run Bash showed `status: "waiting", waitingFor: "permission prompt"`, and Hoku
  listed it under Needs You as "Waiting for permission · Bash" within one monitor tick.

---

## 3. Codex Desktop

### Persistence (`~/.codex`)

| Path | Content | Safe read-only? |
|---|---|---|
| `state_5.sqlite` (WAL) | **Canonical thread index**: `threads`, `projects`, `project_roots`, `thread_spawn_edges` | Yes, opened read-only |
| `sessions/YYYY/MM/DD/rollout-*.jsonl` | Full transcripts | Not needed |
| `archived_sessions/` | Archived rollouts | Not needed |
| `session_index.jsonl` | `{id, thread_name, updated_at}` | Yes, but redundant |
| `thread-writer-locks/<thread-id>.lock` | Present while a thread is held open by a writer | Yes (existence only) |
| `sqlite/codex-dev.db` | Desktop-app catalog (`local_thread_catalog`, automations) | Yes, but redundant |
| `logs_2.sqlite` | App-server logs | Used only to verify deep links |
| `auth.json` | Credentials | **Not read** |

The `state_5.sqlite` file has a version suffix, so the adapter looks for the highest `state_*.sqlite`.

### `threads` (relevant columns)

`id`, `title`, `name` (user-visible thread name), `first_user_message`, `preview`, `cwd`,
`git_branch`, `git_origin_url`, `git_sha`, `created_at_ms`, `updated_at_ms`, `recency_at_ms`,
`archived`, `is_pinned`, `source` (`vscode` = desktop app, or a JSON blob for sub-agents),
`thread_source` (`user` | `automation` | `realtime_voice` | NULL), `project_id`, `model`,
`tokens_used`, `agent_nickname`.

A typical index mixes user-facing threads with archived threads, automation runs and
sub-agent threads; only the user-facing active ones are indexed.

### `projects` / `project_roots`

Codex has its own projects (`name`, `metadata` JSON with `appearance.color`,
`appearance.marker`), each with root paths, e.g. *Example* →
`/Users/<you>/Projects/example`. They are offered as **project suggestions**.

### Deep links – verified

Strings found in the app bundle: `codex://threads/${id}`, `codex://threads/new`,
`codex://settings/connections`, `codex://shared-thread`. The app's own **"Copy thread link"**
action writes `codex://threads/<id>` to the clipboard.

**Live test:** `open "codex://threads/<thread-id>"`. Within 1 s,
`logs_2.sqlite` showed `thread/resume` and `thread/turns/list` requests referencing that thread
id. **Direct thread opening works.**

### Account

`codex login status` (bundled CLI) prints `Logged in using ChatGPT`. That reports the auth
mode without exposing tokens. Account identity (email) is not readable without opening
`auth.json`, so the account label comes from the user.

### MVP decision

- Scan `state_*.sqlite` read-only. By default, exclude archived threads, `automation` runs and
  sub-agent threads (they are noise for a session index).
- Open with `codex://threads/<id>`.
- Runtime: rollout tail events (`task_started`, `task_complete`, `turn_aborted`, `error`),
  plus pending tool calls. An escalated command (`sandbox_permissions: "require_escalated"`)
  that is still unanswered means Codex is waiting for approval. Such a request can stay
  pending for hours until the user answers it. `logs_2.sqlite` only
  records approval *responses*, so it isn't used. Lock files persist for weeks, so a lock
  alone only means "open", at low confidence.

---

## 4. Claude Desktop

### Chat conversations

Chats live server-side. Locally there is only Chromium storage (`IndexedDB`,
`Local Storage` LevelDB, caches) under `~/Library/Application Support/Claude/`. Parsing that is
fragile and undocumented, and it sits next to auth state. **Not used.** `config.json` contains
OAuth token caches and is **not read**.

**Deep link verified in app code** (`index.chunk-*.js`, `claudeURLHandler`):

- `claude://claude.ai/chat/<uuid>` → navigates to `/chat/<uuid>`; the uuid must match a strict
  UUID regex
- `claude://claude.ai/project/<uuid>` → `/project/<uuid>`
- `claude://claude.ai/new?q=…`
- `https://claude.ai/chat/<uuid>` → normalized by us to the `claude://` form

So manual add accepts a web URL, a `claude://` link or a bare UUID. All three normalize to
`claude://claude.ai/chat/<uuid>`.

### Cowork sessions (local agent mode) – discoverable

`~/Library/Application Support/Claude/local-agent-mode-sessions/<account>/<org>/local_<uuid>.json`
holds **structured JSON metadata** per Cowork session: `sessionId`, `title`, `initialMessage`,
`createdAt`, `lastActivityAt`, `isArchived`, `userSelectedFolders`, `model`, `accountName`,
`emailAddress`, `cliSessionId`. Some keys hold large blobs (system
prompts); the adapter reads only the fields listed.

Deep link: the handler routes `claude://claude.ai/local_sessions/<id>` to the in-app
`/local_sessions/<id>` route (same router table as `/cowork`). A live test raised no
`claudeURLHandler` warning in `~/Library/Logs/Claude/main.log`. Unknown paths do log a
warning. Treated as **supported, verify visually**.

### Claude Code inside Claude Desktop

`claude://code/continue?session=<id>` exists, but the accepted session-id format is internal.
It is not used; Claude Code sessions open in a terminal instead.

### MVP decision

- Chats: manual add, normalized to `claude://claude.ai/chat/<uuid>`, opened with `open`.
- Cowork: read-only discovery from the JSON metadata above, opened with
  `claude://claude.ai/local_sessions/<id>`.
- Account: `claude auth status` (Claude Code CLI) reports email, org and plan without secrets.
  It serves as the account hint for the Claude provider.

---

## 5. Capability summary

| Provider | Discovery | Direct open | Fallback | Account state |
|---|---|---|---|---|
| Claude Code | ✅ transcripts + live registry | ✅ `attach` / focus TTY / `--resume` | copy `claude --resume <id>` | ✅ `claude auth status` |
| Claude Desktop chat | ❌ not safe (server-side, LevelDB cache) | ✅ `claude://claude.ai/chat/<uuid>` | open web URL | ⚠ external app (via CLI hint) |
| Claude Desktop Cowork | ✅ local JSON metadata | ✅ `claude://claude.ai/local_sessions/<id>` (code-verified) | open Claude | same |
| Codex Desktop | ✅ `state_*.sqlite` (read-only) | ✅ `codex://threads/<id>` (log-verified) | copy thread id | ⚠ auth mode only (`codex login status`) |

## 6. Uncertain / not pursued

- `claude-cli://` URL formats: the handler binary is the CLI itself. The format is
  undocumented, so it is not used.
- Codex account identity (email): only in `auth.json`, which is not read.
- Claude Desktop chat titles: server-side only. Titles come from the user on manual add.
- Focusing an interactive Claude Code terminal depends on the user granting Automation
  permission to Hoku for iTerm2/Terminal.
- VS Code: only the app is activated. Selecting the right window or integrated-terminal tab
  would need Accessibility access or reading another process's environment, which Hoku
  doesn't do. With macOS's "switch to a Space with open windows" setting off, a VS Code
  window on another desktop can't be moved here (no scriptable window list), so Hoku shows
  the Spaces hint instead.

## 7. Security implications

- External SQLite is opened with `SQLITE_OPEN_READ_ONLY` and `PRAGMA query_only`. WAL databases can be read concurrently without
  taking write locks.
- Transcript contents are never stored. Only a title and the first ~200 characters of the
  first prompt are kept, as a searchable preview.
- Hoku itself makes no network requests. Account state comes from the providers' own CLIs
  (`claude auth status`, `codex login status`), which print status only; those third-party
  binaries may contact their own servers.
- Terminal launching passes session ids and paths through validation (an id
  allow-list regex, absolute existing directory, shell quoting) and AppleScript string escaping. This prevents command
  injection through crafted metadata.
