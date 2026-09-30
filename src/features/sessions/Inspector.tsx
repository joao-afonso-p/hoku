import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { copy, fail, followUp, followUpDone, forgetSession, openSession, patchSession, reload, reveal, select, toggleFavorite } from "../../app/actions";
import { useHub } from "../../app/store";
import { useMinuteClock } from "../../app/useClock";
import { useVisibility } from "../../app/model";
import { isSessionVisible } from "../galaxy/visibility";
import { api } from "../../lib/api";
import { tildify } from "../../lib/paths";
import { absoluteTime, relativeTime } from "../../lib/time";
import type { Session } from "../../lib/types";
import { IconArrowUpRight, IconCheck, IconClock, IconClose, IconCopy, IconEdit, IconFlag, IconFlagFilled, IconFolder, IconLink, IconStar, IconStarFilled, IconTrash } from "../../components/Icons";
import { openDescription, openHint, PROVIDERS, surfaceLabel } from "../../providers";
import { GlyphIcon } from "../constellation/Glyph";
import { isInferred, reasonText, STATUS, stateSince, statusKey } from "../runtime/status";
import { StatusDot } from "../runtime/StatusMark";
import { DueMenu } from "../follow-up/DueMenu";
import { addedLabel, dueLabel, followUpKey, OVERDUE } from "../follow-up/followUp";
import { forgetMessage, forgetPlan, NEXT_STEP_MAX, nextStepLength } from "./forget";

export const INSPECTOR_WIDTH = 348;

const RUNTIME_SOURCE: Record<string, string> = {
  "claude-code-registry": "Claude Code session registry",
  "codex-rollout": "Codex thread rollout",
  "claude-desktop-metadata": "Claude Desktop metadata",
  demo: "Demo data",
  none: "No live signal",
};

const SOURCE_LABEL: Record<string, string> = {
  "claude-code-transcripts": "Claude Code transcripts · read-only",
  "codex-state-db": "Codex thread index · read-only",
  "claude-cowork": "Claude Desktop Cowork metadata · read-only",
  manual: "Added manually",
  demo: "Demo data",
};


export function Inspector({ session }: { session: Session }) {
  const projects = useHub((s) => s.data.projects);
  const accounts = useHub((s) => s.data.accounts);
  const links = useHub((s) => s.data.links);
  const sessions = useHub((s) => s.data.sessions);
  const terminalPref = useHub((s) => String(s.data.settings.terminal ?? "auto"));
  const p = PROVIDERS[session.provider];
  const [editingTitle, setEditingTitle] = useState(false);
  const [title, setTitle] = useState(session.title);
  const [notes, setNotes] = useState(session.notes ?? "");

  useEffect(() => {
    setTitle(session.title);
    setNotes(session.notes ?? "");
    setEditingTitle(false);
  }, [session.id, session.title, session.notes]);

  const accountOptions = accounts.filter((a) => a.provider === (session.provider === "codex" ? "codex" : "claude"));
  const related = useMemo(() => {
    const ids = links.filter((l) => l.fromId === session.id || l.toId === session.id).map((l) => (l.fromId === session.id ? l.toId : l.fromId));
    return sessions.filter((s) => ids.includes(s.id));
  }, [links, sessions, session.id]);
  const linkCandidates = sessions.filter((s) => s.id !== session.id && s.projectId === session.projectId && !related.some((r) => r.id === s.id));

  const meta = session.metadata ?? {};
  const prUrl = typeof meta.prUrl === "string" ? meta.prUrl : null;
  const firstPrompt = typeof meta.firstPrompt === "string" ? meta.firstPrompt : null;
  const model = typeof meta.model === "string" ? meta.model : null;
  const live = meta.live as { kind?: string; jobId?: string } | undefined;
  const isDemo = session.source === "demo";
  const v = useVisibility();
  const expanded = useHub((s) => s.expanded);
  const hiddenInCurrent = v.mode === "current" && expanded === null && !isSessionVisible(session, v);
  const resumeCmd = session.provider === "claude-code" && session.externalId ? `claude --resume ${session.externalId}` : null;

  const saveTitle = () => {
    setEditingTitle(false);
    if (title.trim() && title.trim() !== session.title) void patchSession(session.id, { title: title.trim() }, true);
    else setTitle(session.title);
  };

  const link = async (otherId: string) => {
    try {
      await api.setLink(session.id, otherId, true);
      await reload();
    } catch (e) {
      fail(e);
    }
  };
  const unlink = async (otherId: string) => {
    try {
      await api.setLink(session.id, otherId, false);
      await reload();
    } catch (e) {
      fail(e);
    }
  };

  return (
    <aside
      className="panel slide-in-right absolute top-[52px] right-3 bottom-3 z-20 flex flex-col overflow-hidden rounded-[12px]"
      style={{ width: INSPECTOR_WIDTH }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between px-4 pt-3.5">
        <div className="flex min-w-0 items-center gap-1.5 text-[11.5px]" style={{ color: p.accent }}>
          <GlyphIcon kind={p.glyph} color={p.accent} size={10} hollow={session.sourceMissing} />
          <span>{surfaceLabel(session)}</span>
        </div>
        <button className="btn btn-ghost h-6 w-6 justify-center px-0 text-ink-3" onClick={() => select(null)} aria-label="Close">
          <IconClose size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {editingTitle ? (
          <input
            autoFocus
            className="field mt-2 text-[15px] font-semibold"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={saveTitle}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveTitle();
              if (e.key === "Escape") {
                e.stopPropagation();
                setTitle(session.title);
                setEditingTitle(false);
              }
            }}
          />
        ) : (
          <h2 className="group mt-2 flex items-start gap-1.5 text-[15.5px] leading-snug font-semibold text-ink" onDoubleClick={() => setEditingTitle(true)}>
            <span className="min-w-0 flex-1">{session.title}</span>
            <button className="mt-0.5 text-ink-4 opacity-0 transition-opacity group-hover:opacity-100 hover:text-ink-2" onClick={() => setEditingTitle(true)} aria-label="Rename">
              <IconEdit size={14} />
            </button>
          </h2>
        )}
        <RuntimeBlock session={session} />

        {hiddenInCurrent && (
          <div className="mt-2 text-[11.5px] text-ink-4">
            Not on the Current map: no activity in the last {v.recentWindowDays} days.
          </div>
        )}

        <button
          className="btn btn-primary mt-4 h-9 w-full justify-between px-3.5 text-[13px]"
          disabled={isDemo || (session.sourceMissing && session.provider === "claude-code")}
          onClick={() => void openSession(session)}
          title={openHint(session, terminalPref)}
        >
          <span className="flex items-center gap-2">
            <IconArrowUpRight size={15} className="nudge" />
            {openDescription(session)}
          </span>
          <span className="text-[11px] opacity-60">↵</span>
        </button>

        <div className="mt-2 flex flex-wrap gap-1.5">
          {session.externalId && (
            <button className="btn" onClick={() => void copy(session.externalId!, "ID")}>
              <IconCopy size={13} /> Copy ID
            </button>
          )}
          {(session.deepLink || resumeCmd) && (
            <button className="btn" onClick={() => void copy(session.deepLink ?? resumeCmd!, session.deepLink ? "Deep link" : "Resume command")}>
              <IconLink size={13} /> {session.deepLink ? "Copy link" : "Copy command"}
            </button>
          )}
          {session.workingDirectory && (
            <button className="btn" onClick={() => void reveal(session.workingDirectory!)}>
              <IconFolder size={13} /> Reveal
            </button>
          )}
          <button className="btn" onClick={() => void toggleFavorite(session)} aria-pressed={session.favorite}>
            {session.favorite ? <IconStarFilled size={13} className="text-star" /> : <IconStar size={13} />}
            {session.favorite ? "Favorited" : "Favorite"}
          </button>
          {!session.followUp && (
            <button className="btn" onClick={() => void followUp(session)} title="Review this session later (F)">
              <IconFlag size={13} /> Follow up
            </button>
          )}
        </div>

        {session.followUp && <FollowUpBlock session={session} />}

        <dl className="mt-5 border-t border-line pt-3">
          <div className="meta-row">
            <dt>Project</dt>
            <dd>
              <select
                className="field -my-1 h-7 py-0 text-[12.5px]"
                value={session.projectId ?? ""}
                onChange={(e) => void patchSession(session.id, { projectId: e.target.value || null }, true)}
              >
                <option value="">Unsorted</option>
                {projects
                  .filter((pr) => !pr.archivedAt || pr.id === session.projectId)
                  .map((pr) => (
                    <option key={pr.id} value={pr.id}>
                      {pr.archivedAt ? `${pr.name} (archived)` : pr.name}
                    </option>
                  ))}
              </select>
            </dd>
          </div>
          <div className="meta-row">
            <dt>Account</dt>
            <dd>
              {accountOptions.length > 1 ? (
                <select
                  className="field -my-1 h-7 py-0 text-[12.5px]"
                  value={session.providerAccountId ?? ""}
                  onChange={(e) => void patchSession(session.id, { providerAccountId: e.target.value || null }, true)}
                >
                  {accountOptions.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label}
                    </option>
                  ))}
                </select>
              ) : (
                (accountOptions.find((a) => a.id === session.providerAccountId)?.label ?? "—")
              )}
            </dd>
          </div>
          <Row label="Last activity" value={absoluteTime(session.lastActivityAt)} />
          <Row
            label="Live state"
            value={`${RUNTIME_SOURCE[session.runtime.source ?? ""] ?? session.runtime.source ?? "Not evaluated yet"} · ${session.runtime.confidence} confidence${
              session.runtime.lastObservedAt ? ` · checked ${relativeTime(session.runtime.lastObservedAt)}` : ""
            }`}
          />
          {session.lastOpenedAt && <Row label="Last opened" value={relativeTime(session.lastOpenedAt)} />}
          {session.workingDirectory && <Row label="Directory" value={tildify(session.workingDirectory)} mono />}
          {session.repository && session.repository !== session.workingDirectory && <Row label="Repository" value={tildify(session.repository)} mono />}
          {session.branch && <Row label="Branch" value={session.branch} mono />}
          {prUrl && <Row label="Pull request" value={prUrl.replace(/^https:\/\/github.com\//, "")} mono />}
          {model && <Row label="Model" value={model} />}
          {live?.kind && <Row label="Process" value={live.kind === "bg" ? `Background · ${live.jobId ?? ""}` : "Interactive terminal"} />}
          {session.externalId && <Row label="ID" value={session.externalId} mono />}
          {session.deepLink && <Row label="Deep link" value={session.deepLink} mono />}
          <Row label="Source" value={SOURCE_LABEL[session.source ?? ""] ?? session.source ?? "—"} />
          {session.discovery === "scan" && <Row label="Discovery" value="Found by scan · refreshed on every scan" />}
          {session.sourceMissing && <Row label="Status" value="No longer present at the source" />}
        </dl>

        {firstPrompt && (
          <div className="mt-4">
            <div className="eyebrow mb-1.5">First prompt</div>
            <p className="border-l border-line-strong pl-3 text-[12px] leading-relaxed text-ink-3">{firstPrompt}</p>
          </div>
        )}

        <div className="mt-4">
          <div className="eyebrow mb-1.5">Notes</div>
          <textarea
            className="field min-h-[68px] resize-none text-[12.5px] leading-relaxed"
            placeholder="Why this session matters…"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => {
              if ((session.notes ?? "") !== notes) void patchSession(session.id, { notes: notes || null }, true);
            }}
          />
        </div>

        <div className="mt-4">
          <div className="eyebrow mb-1.5">Related sessions</div>
          {related.map((r) => (
            <div key={r.id} className="group flex items-center gap-2 py-1 text-[12.5px]">
              <GlyphIcon kind={PROVIDERS[r.provider].glyph} color={PROVIDERS[r.provider].accent} size={9} />
              <button className="min-w-0 flex-1 truncate text-left text-ink-2 hover:text-ink" onClick={() => select(r.id)}>
                {r.title}
              </button>
              <button className="text-[11px] text-ink-4 opacity-0 group-hover:opacity-100 hover:text-ink-2" onClick={() => void unlink(r.id)}>
                Unlink
              </button>
            </div>
          ))}
          {linkCandidates.length > 0 && (
            <select className="field mt-1 h-7 py-0 text-[12px] text-ink-3" value="" onChange={(e) => e.target.value && void link(e.target.value)}>
              <option value="">Link a session from this project…</option>
              {linkCandidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {PROVIDERS[c.provider].label} · {c.title}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      <ForgetFooter key={session.id} session={session} note={notes} />
    </aside>
  );
}

/**
 * Forget removes Hoku's record only, never the provider's copy. Say so before it happens, and
 * offer to keep the note as the project's next step, since it would be lost with the record.
 */
function ForgetFooter({ session, note }: { session: Session; note: string }) {
  const project = useHub((s) => s.data.projects.find((x) => x.id === session.projectId));
  const [open, setOpen] = useState(false);
  const [keep, setKeep] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const provider = PROVIDERS[session.provider].label;
  const plan = forgetPlan(session, project, note);
  // The note can be cleared while the confirm is open; never keep what's no longer offered.
  const keeping = keep && plan.canKeep;
  const length = nextStepLength(text);

  if (!open) {
    return (
      <div className="flex items-center justify-between border-t border-line px-4 py-2.5">
        <span className="text-[11px] text-ink-4">
          Double-click title to rename · <span className="kbd">F</span> follow up
        </span>
        <button
          className="btn btn-ghost h-7 px-2 text-[12px] text-ink-3 hover:text-danger"
          onClick={() => {
            setKeep(plan.keepByDefault);
            setText(plan.note);
            setOpen(true);
          }}
          title={`Remove from Hoku. ${provider} keeps its copy.`}
        >
          <IconTrash size={13} /> Forget
        </button>
      </div>
    );
  }

  const forget = async () => {
    setBusy(true);
    await forgetSession(session, keeping ? text.trim() : undefined);
    setBusy(false);
  };
  // Keys act on the confirm, not the app (Enter would open the session, F toggle follow up).
  const onKey = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey) return;
    e.stopPropagation();
    if (e.key === "Escape") setOpen(false);
  };

  return (
    <div className="border-t border-line px-4 py-3 text-[12px]" onKeyDown={onKey}>
      <div className="text-ink-2">Forget this session in Hoku?</div>
      <p className="mt-1 text-[11.5px] leading-relaxed text-ink-3">{forgetMessage(plan, provider)}</p>
      {plan.canKeep && project && (
        <div className="mt-2.5">
          <label className="flex items-center gap-2 text-ink-2">
            <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
            {plan.replaces ? `Replace ${project.name}’s next step with the note` : `Keep the note as ${project.name}’s next step`}
          </label>
          {keeping && (
            <>
              {plan.replaces && <p className="mt-1 line-clamp-2 text-[11px] text-ink-4">Now: “{plan.replaces}”</p>}
              <textarea
                className="field mt-1.5 min-h-[56px] resize-none text-[12px] leading-relaxed"
                value={text}
                onChange={(e) => setText(e.target.value)}
                aria-label="Next step"
              />
              <div className={`mt-0.5 text-right text-[10.5px] tabular-nums ${length > NEXT_STEP_MAX ? "text-danger" : "text-ink-4"}`}>
                {length}/{NEXT_STEP_MAX}
              </div>
            </>
          )}
        </div>
      )}
      <div className="mt-2.5 flex justify-end gap-1.5">
        <button className="btn btn-ghost" autoFocus onClick={() => setOpen(false)}>
          Cancel
        </button>
        <button className="btn text-danger" disabled={busy || (keeping && (length === 0 || length > NEXT_STEP_MAX))} onClick={() => void forget()}>
          <IconTrash size={13} /> Forget
        </button>
      </div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="meta-row">
      <dt>{label}</dt>
      <dd className={mono ? "font-mono text-[11.5px] select-text" : "select-text"}>{value}</dd>
    </div>
  );
}

/** The user's own reminder. Deliberately quieter than Needs You: nothing is blocked on it. */
function FollowUpBlock({ session }: { session: Session }) {
  const now = useMinuteClock();
  const f = session.followUp!;
  const key = followUpKey(f, now);
  const color = key === "overdue" ? OVERDUE : key === "due" ? "var(--color-star)" : undefined;
  return (
    <div className="mt-3 rounded-[9px] border border-line px-2.5 py-2 text-[12px]">
      <div className="flex items-center gap-1.5">
        <IconFlagFilled size={12} className="text-ink-3" />
        <span className="font-medium text-ink-2">Follow up</span>
        <span className={color ? "" : "text-ink-3"} style={{ color }} title={f.dueAt ? new Date(f.dueAt).toLocaleString() : undefined}>
          · {dueLabel(f, now)}
        </span>
        <span className="ml-auto shrink-0 text-[11px] text-ink-4">{addedLabel(f, now)}</span>
      </div>
      <div className="mt-2 flex gap-1.5">
        <DueMenu session={session} className="btn h-7 px-2.5 text-[12px]" title="Snooze or set a reminder">
          <IconClock size={13} /> {f.dueAt ? "Snooze" : "Remind me"}
        </DueMenu>
        <button className="btn h-7 px-2.5 text-[12px]" onClick={() => void followUpDone(session)} title="Done: remove from Follow up (F)">
          <IconCheck size={13} /> Done
        </button>
      </div>
    </div>
  );
}

/** State first, then why, then how sure we are. Needs You reads as a call to action. */
function RuntimeBlock({ session }: { session: Session }) {
  const key = statusKey(session);
  const meta = STATUS[key];
  const since = stateSince(session);
  const attention = key === "needs_you";
  return (
    <div
      className={`mt-2 rounded-[9px] px-2.5 py-2 text-[12px] ${attention ? "border" : ""}`}
      style={attention ? { borderColor: `${meta.color}40`, background: `${meta.color}0d` } : undefined}
    >
      <div className="flex items-center gap-1.5">
        <StatusDot status={key} size={8} />
        <span style={{ color: key === "offline" || key === "unknown" || key === "idle" ? undefined : meta.color }} className="font-medium text-ink-2">
          {meta.label}
        </span>
        <span className="truncate text-ink-3">· {reasonText(session)}</span>
        {since && key !== "offline" && key !== "unknown" && <span className="ml-auto shrink-0 text-[11px] text-ink-4">{relativeTime(since)}</span>}
      </div>
      {session.runtime.detail && <div className="mt-1 pl-[20px] text-[11.5px] leading-snug text-ink-2">{session.runtime.detail}</div>}
      {isInferred(session) && key !== "offline" && key !== "unknown" && (
        <div className="mt-1 pl-[20px] text-[11px] text-ink-4">Inferred from local metadata ({session.runtime.confidence} confidence). The provider doesn’t report this directly.</div>
      )}
    </div>
  );
}
