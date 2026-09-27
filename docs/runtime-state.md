# Runtime state and attention

Hoku answers one question: **what is happening across my AI work, and what needs me?**
Every session carries a normalized, provider-agnostic runtime status. Needs You is built on
top of it as a first-class inbox.

Code: `src-tauri/src/runtime.rs` (monitor, watchdog, events), `providers/*.rs` (per-provider
signals), `src/features/runtime/status.ts` (UI semantics). Tests sit next to each.

## The model

```ts
type RuntimeState = "working" | "needs_input" | "ready" | "idle" | "offline" | "error" | "unknown";

interface RuntimeStatus {
  state: RuntimeState;
  confidence: "high" | "medium" | "low";
  reason?: string;          // "Waiting for permission", "Running Bash", "Finished its turn"
  detail?: string;          // the tool, the question asked, an error message (≤160 chars)
  source?: string;          // "claude-code-registry" | "codex-rollout" | "claude-desktop-metadata" | "none" | "demo"
  actionRequired: boolean;  // a human must act: always for needs_input; some errors
  since?: string;           // when this state began (provider timestamp when known)
  lastObservedAt?: string;  // when the monitor last confirmed it
}
```

| State | Meaning |
|---|---|
| **working** | Actively executing a turn: generating, running tools. |
| **needs_input** | Blocked on an explicit human action: permission, a question, a confirmation. |
| **ready** | Finished its turn and is waiting for a new prompt. **Not** Needs You. |
| **idle** | Open or alive, nothing happening. |
| **offline** | Known historically. No live process or loaded thread. |
| **error** | A failure ended the last turn. `actionRequired` when a human must fix it (e.g. authentication). |
| **unknown** | Can't be determined reliably. |

Confidence is never faked. `high` means the provider reported the state itself. `medium`
and `low` mean it was inferred, and the UI says "inferred" or "Likely:" next to it.

**Needs You** = `needs_input`, or `error` with `actionRequired`. The sidebar badge, the Needs
You inbox and the Galaxy filter all use that one rule (`needsYou()` in `status.ts`). Ready,
idle and offline never count.

For counts and filters, each session maps to exactly one **status key**: `needs_you`, `error`
(errors that don't need you), `working`, `ready`, `idle`, `offline`, `unknown`. Counts
therefore always add up.

Visual priority: Needs You → Error → Working → Ready → Idle → Offline → Unknown.

## Provider signals

| Provider | Signal | Live state |
|---|---|---|
| **Claude Code** | Its own session registry `~/.claude/sessions/<pid>.json`. Claude Code writes `status` (`busy` · `waiting` · `idle` · `shell`) and, while waiting, `waitingFor` (`permission prompt`, `input needed`, `dialog open`, `sandbox request`, `worker request`, `goal proposal`) on every change, with `statusUpdatedAt`. The pid is checked with `kill(pid, 0)`. The last 256 KB of the transcript adds the pending tools, tracked by `tool_use` id so a parallel call that finishes doesn't hide one still waiting (`Running Bash`, `AskUserQuestion` → "Asked a question" + the question, `ExitPlanMode` → "Plan needs approval"), and API errors (`authentication_failed` → Authentication required, actionable; `rate_limit` → Usage limit reached; `server_error` → Request failed). | **Full**, high confidence |
| **Codex Desktop** | Rollout tail (`sessions/…/rollout-*.jsonl`, last 256 KB) for threads that are held open (`thread-writer-locks/<id>.lock`) or were updated in the last 12 h. `task_started` → working · `task_complete` → ready · `turn_aborted` → idle · `error` → error. Every call without an output is tracked by `call_id` (see [Codex approvals](#codex-approvals)): a pending `request_user_input` → **Asked a question**, a pending `request_permissions` → **Permission requested**, a pending call Codex would ask about, still unanswered after 4 s → **Waiting for approval** (its `justification` is the detail). Codex app not running → offline (high). | **Partial**, medium confidence |
| **Claude Desktop · Cowork** | Only whether Claude Desktop runs and when a session's metadata file last changed. Changed < 90 s ago → working (low). < 30 min → unknown. Otherwise offline (low). It never claims Needs You. | **Limited**, low confidence |
| **Claude Desktop · chats** | Nothing local. Always unknown. | **None** |

### Claude Code: registry first, transcript as a backstop

The registry's `waiting` is authoritative: any `waitingFor` is Needs You, and the transcript
only names what it's waiting for. The transcript overrides a `busy` registry in one case: a
pending `AskUserQuestion` or `ExitPlanMode`. Those tools always stop for the user, so the
session is Needs You (medium confidence) even if the registry hasn't caught up or the Claude
Code build doesn't publish `waiting`. Any other pending tool on a busy session stays
**working**: most tools run without asking, and the registry says when one does.

### Codex approvals

Codex doesn't write approval requests (`exec_approval_request`,
`apply_patch_approval_request`, `request_permissions`, `request_user_input` events) to the
rollout. The only trace is a call that has no output yet, so Hoku infers the request from the
call:

| Pending call | State | Confidence |
|---|---|---|
| `request_user_input` | Needs You · Asked a question (at once) | medium |
| `request_permissions` | Needs You · Permission requested (at once) | medium |
| `sandbox_permissions: "require_escalated"` or `"with_additional_permissions"` (older builds: `with_escalated_permissions: true`), as JSON arguments or in code-mode JavaScript, unanswered for 4 s on a quiet rollout | Needs You · Waiting for approval | medium |
| Any command (`exec_command`, `shell`, `shell_command`, code-mode `exec`) under the `untrusted` policy, unanswered for 4 s | Needs You · Waiting for approval | low |
| A code-mode `exec` cell that yielded ("Script running with cell ID …") carrying one of the above, while the model only polls it with `wait` | Needs You · Waiting for approval | low |
| Anything else | Working · Running `<tool>` | medium |

Nothing prompts under the `never` policy. The policy comes from the rollout's latest
`turn_context.approval_policy`, falling back to the thread index's `approval_mode`.

Codex runs one response's calls in parallel and writes their outputs in call order once they
finish. An escalated call waiting for approval therefore holds back the outputs of every call
after it. **This caused the "Working while waiting for approval" bug:** only the latest
pending call was kept, so an escalated call followed by a plain one (`git status` next to
`gh pr create`) read as "Running exec_command". Every unanswered call now counts.

Known gaps, where Codex's decision isn't visible in the rollout: an `apply_patch` outside the
writable roots, MCP tool approvals, and commands Codex itself classes as dangerous. These
still show as working. An approved escalated command that runs for a long time stays
"Waiting for approval" until its output lands, since approval and execution look the same.

### Why no Claude Code hooks

Hooks (`UserPromptSubmit`, `PreToolUse`, `Notification`, `Stop`, …) would work, but they
require writing to the user's `~/.claude/settings.json`, and Hoku is read-only towards
providers. The registry is written by Claude Code itself on every state change and carries
the same information: busy vs waiting vs idle, plus what it's waiting for. So Hoku gets
event-grade signals without touching provider config.

### Why not Codex logs

`logs_2.sqlite` records approval *responses* (`op: ExecApproval`) but not the requests, and
parsing debug traces is brittle. The rollout already holds the pending escalated call.

## The monitor

`runtime.rs` runs on its own thread every **4 s**. Each pass:

1. Reads the index, then asks each adapter for a `RuntimeProbe` **without** holding the DB
   lock. Probes are read-only and cheap, and transcript and rollout tails are cached by
   (size, mtime).
2. Applies the watchdog (below) and diffs against the stored status.
3. Writes only what changed, records semantic events, and emits `hub://runtime` to the UI,
   which reloads. There is no UI polling. The window regaining focus triggers an immediate
   pass (`refresh_runtime`).
4. If a provider reports a live session that isn't indexed yet (a new Claude Code terminal),
   runs an adapter-scoped discovery. Attempts are throttled to 8 s per adapter and 15 s per
   session.

`announce()` is the single place where transitions leave the monitor. macOS notifications
(Needs You, Error, optionally Ready) belong there later. Every transition already carries
`from`, `to`, the event type and `actionRequired`.

### Watchdog defaults

| Rule | Default | Why |
|---|---|---|
| working with no provider activity | **20 min** → unknown (low) | A busy flag that stops changing isn't believable forever. Long builds still get 20 min. |
| ready | **45 min** → idle | Ready means "recently finished"; after that it's just open. |
| error without follow-up | **6 h** → idle | A failed turn shouldn't shout forever. |
| needs_input | **no timeout** | It stays until the provider clears it (answered, stopped, process gone). |

Nothing flips on a single missing observation. A state changes only when a provider reports
something different or a watchdog threshold passes.

## Activity events

Semantic transitions are persisted in `activity_events` (90-day retention):

| Transition | Event |
|---|---|
| → working | `started_working` (`resumed` if it was waiting on you) |
| → needs_input | `needs_input` |
| → ready | `became_ready` |
| → error | `error` |
| working / needs_input → idle | `became_idle` |
| offline / unknown → idle | `opened` |
| live → offline | `went_offline` |
| manual add | `created` |

Individual tool calls are never recorded. The same event for a session within 2 minutes is
recorded once, and event times never go backwards. The first time Hoku evaluates a session
(first launch, fresh import), only what matters now is recorded: needs input, working,
ready, error. "Offline" is never flooded.

## Storage

Migration v2 adds `runtime_state`, `runtime_confidence`, `runtime_reason`,
`runtime_detail`, `runtime_source`, `runtime_action`, `runtime_since` and
`runtime_observed_at` to `sessions`, plus the `activity_events` table (cascades with its
session). The legacy `activity_state` column is kept but no longer read. Persisted state is
not authoritative: the first monitor pass after launch re-derives every live session.

Stored runtime text is a short reason plus an optional ≤160-character detail (a tool name,
an approval question, an error message), in keeping with the ≤200-character prompt preview.
Transcripts are never stored.

## Where it shows up

- **Sidebar**: Galaxy · **Needs You (badge)** · Activity · Favorites · Projects · Sessions.
  Working, Ready, Idle and Offline are filters, not destinations.
- **Galaxy**: `Current · 7d | All`, quick filters `Needs You n` and `Working n` (which double
  as the "what's happening now" summary), and a multi-select `Status ▾`. Filtering never
  moves anything: non-matching sessions fade to ~14% and projects with no match to ~16%.
  The summary line reads "3 projects · 4 sessions need you".
- **Project Focus**: provider = angle, runtime relevance = radius inside the Live zone (see
  constellation-layout.md). Needs You has an amber halo, errors a coral ring, working a
  breathing halo, ready a thin ring. Idle, offline and unknown get quieter in that order.
- **Needs You**: the inbox, as a list. Blocking errors first, then the longest wait first,
  with the reason and detail.
- **Activity**: the cross-provider timeline (Today · 7d · 30d, provider filter). The top bar
  shows "N finished" since you last opened it. Ready is news, not an inbox item.
- **Sessions**: the management table with search, sort and filters (project, provider,
  status, account, favorites, last activity), built on `features/sessions/filter.ts`, the
  one shared filter.
- **⌘K**: always searches every session. Results show the state. `⌥↵` filters the Galaxy to
  that state, `⌘P` goes to the project, `⌘D` favorites.
- **Integration Center**: live-state support per source: ✓ full, ◐ inferred, — none.
