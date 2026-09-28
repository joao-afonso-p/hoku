import { useEffect, useMemo, useState, type ReactNode } from "react";
import { openOverlay, openSession, saveProjectResume, scan, select, toggleList } from "../../app/actions";
import { enterSession } from "../activity/drawerActions";
import { setState, useHub } from "../../app/store";
import { useMinuteClock } from "../../app/useClock";
import { relativeTime } from "../../lib/time";
import type { Project, Session } from "../../lib/types";
import { openDescription, PROVIDERS, surfaceLabel } from "../../providers";
import { IconArrowUpRight, IconClose, IconEdit, IconLink } from "../../components/Icons";
import { GlyphIcon } from "../constellation/Glyph";
import { countStatuses, isInferred, reasonText, STATUS, statusKey } from "../runtime/status";
import { RuntimeSummaryText, StatusDot, StatusLabel } from "../runtime/StatusMark";
import { AiDraftPanel } from "./AiDraftPanel";
import { buildResume, canOpen, CHANGE_WINDOW_DAYS, prLabel, RECENT_COUNT, RESUME_VERB, type ContinueWith } from "./model";

export const RESUME_WIDTH = 392;
/** Settings key shared with the backend (`resume::SETTING_KEY`). */
export const AI_DRAFTS_KEY = "ai.drafts.provider";

/**
 * Project Resume: what this project is, what you were doing, what changed, what needs a
 * decision, and where to continue. Everything is local; the AI draft is opt-in and explicit.
 */
export function ResumeDrawer({ project }: { project: Project }) {
  const sessions = useHub((s) => s.data.sessions);
  const activity = useHub((s) => s.data.activity);
  const links = useHub((s) => s.data.links);
  const selectedId = useHub((s) => s.selectedId);
  const aiEnabled = useHub((s) => s.data.settings[AI_DRAFTS_KEY] === "claude-code");
  const now = useMinuteClock();
  const r = useMemo(() => buildResume(project.id, { sessions, activity, links }, now), [project.id, sessions, activity, links, now]);
  const counts = useMemo(() => countStatuses(r.sessions), [r.sessions]);
  const byId = useMemo(() => new Map(r.sessions.map((s) => [s.id, s])), [r.sessions]);
  const [drafting, setDrafting] = useState(false);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    setDrafting(false);
    setShowAll(false);
  }, [project.id]);

  const recent = showAll ? r.recent : r.recent.slice(0, RECENT_COUNT);

  return (
    <aside
      className="panel slide-in-left absolute top-[52px] bottom-3 left-3 z-20 flex flex-col overflow-hidden rounded-[12px]"
      style={{ width: RESUME_WIDTH }}
      onPointerDown={(e) => e.stopPropagation()}
      aria-label={`Resume ${project.name}`}
    >
      <div className="flex items-center justify-between px-4 pt-3.5 pb-1">
        <div className="eyebrow text-ink-2">Resume</div>
        <div className="flex items-center gap-1">
          <button className="btn btn-ghost h-6 px-1.5 text-[11.5px] text-ink-4" onClick={() => openOverlay({ kind: "project", projectId: project.id })} title="Edit project name, folder and accent">
            Edit project
          </button>
          <button className="btn btn-ghost h-6 w-6 justify-center px-0 text-ink-3" onClick={() => setState({ list: null })} aria-label="Close Resume">
            <IconClose size={14} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-4">
        <h2 className="flex items-center gap-2 text-[15.5px] leading-snug font-semibold text-ink">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full border" style={{ borderColor: project.color ?? "#f1ead8" }} />
          <span className="min-w-0 truncate">{project.name}</span>
        </h2>
        <div className="mt-0.5 text-[11.5px] text-ink-3">
          {counts.needs_you + counts.error + counts.working > 0 && (
            <>
              <RuntimeSummaryText counts={counts} /> ·{" "}
            </>
          )}
          {r.sessions.length} {r.sessions.length === 1 ? "session" : "sessions"}
          {r.lastActiveAt && <> · last active {relativeTime(r.lastActiveAt, now)}</>}
          {project.isDemo && <span className="text-ink-4"> · demo data</span>}
        </div>

        {/* What is this project? */}
        <Section
          title="About"
          action={
            aiEnabled && !drafting ? (
              <button className="btn btn-ghost h-6 px-1.5 text-[11.5px] text-ink-3" onClick={() => setDrafting(true)} title="Review what would be sent, then generate an editable draft">
                Draft with Claude…
              </button>
            ) : null
          }
        >
          <EditableText
            key={`d:${project.id}`}
            value={project.description ?? ""}
            max={600}
            label="Project description"
            placeholder="What is this project? One or two sentences for future you."
            onSave={(v) => saveProjectResume(project.id, { description: v || null })}
          />
          {!aiEnabled && !project.description && (
            <button className="mt-1 text-[11px] text-ink-4 hover:text-ink-3" onClick={() => openOverlay({ kind: "settings" })}>
              Or let Claude draft it: optional, off by default · Settings
            </button>
          )}
          {drafting && <AiDraftPanel project={project} onClose={() => setDrafting(false)} />}
        </Section>

        <Section title="Next step">
          <EditableText
            key={`n:${project.id}`}
            value={project.nextStep ?? ""}
            max={280}
            label="Next step"
            placeholder="Where should you pick up? Leave yourself a note."
            onSave={(v) => saveProjectResume(project.id, { nextStep: v || null })}
          />
        </Section>

        {r.sessions.length === 0 ? (
          <div className="mt-5 rounded-[10px] border border-line px-3 py-3 text-[12px] leading-relaxed text-ink-3">
            No sessions in this project yet.
            <div className="mt-1 text-ink-4">
              {project.rootPath
                ? "Sessions that ran inside the project’s folder join it after a scan."
                : "Give the project a root folder so sessions that ran there join it automatically, or move sessions here from their inspector."}
            </div>
            <div className="mt-2 flex gap-1.5">
              <button className="btn" onClick={() => void scan()}>
                Scan now
              </button>
              {!project.rootPath && (
                <button className="btn btn-ghost" onClick={() => openOverlay({ kind: "project", projectId: project.id })}>
                  Set root folder
                </button>
              )}
            </div>
          </div>
        ) : (
          <>
            {r.continueWith && <ContinueCard c={r.continueWith} />}

            <Section title="Needs a decision" meta={r.needs.length > 0 ? <span style={{ color: STATUS.needs_you.color }}>{r.needs.length}</span> : null}>
              {r.needs.length === 0 ? (
                <p className="text-[12px] text-ink-3">Nothing in this project is waiting on you.</p>
              ) : (
                <div className="-mx-2">
                  {r.needs.map((s) => (
                    <SessionRow key={s.id} s={s} selected={s.id === selectedId} now={now} links={r.linkCount.get(s.id) ?? 0} showDetail />
                  ))}
                </div>
              )}
            </Section>

            <Section title="Recent sessions">
              {recent.length === 0 ? (
                <p className="text-[12px] text-ink-3">Every session here is listed under Needs a decision.</p>
              ) : (
                <div className="-mx-2">
                  {recent.map((s) => (
                    <SessionRow key={s.id} s={s} selected={s.id === selectedId} now={now} links={r.linkCount.get(s.id) ?? 0} />
                  ))}
                </div>
              )}
              {r.recent.length > RECENT_COUNT && (
                <button className="mt-1 text-[11.5px] text-ink-3 hover:text-ink-2" onClick={() => setShowAll((v) => !v)} aria-expanded={showAll}>
                  {showAll ? "Show fewer" : `Show ${r.recent.length - RECENT_COUNT} more`}
                </button>
              )}
            </Section>

            <Section title={`What changed · last ${CHANGE_WINDOW_DAYS} days`}>
              {r.changes.length === 0 ? (
                <p className="text-[12px] leading-relaxed text-ink-3">
                  No recorded activity in the last {CHANGE_WINDOW_DAYS} days.
                  <span className="text-ink-4"> Hoku records when sessions start, need you, finish a turn or fail, while it’s running.</span>
                </p>
              ) : (
                <>
                  {r.changeSummary && <p className="mb-1 text-[12px] text-ink-2">{r.changeSummary}</p>}
                  <div className="-mx-2">
                    {r.changes.map((e) => {
                      const s = byId.get(e.sessionId);
                      if (!s) return null;
                      const tone = e.type === "needs_input" ? "needs_you" : e.type === "error" ? "error" : e.type === "became_ready" ? "ready" : e.type === "started_working" || e.type === "resumed" ? "working" : "idle";
                      return (
                        <button key={e.id} className="flex w-full items-start gap-2 rounded-[7px] px-2 py-1 text-left hover:bg-white/[0.04]" onClick={() => enterSession(s)}>
                          <span className="w-[54px] shrink-0 pt-[1px] text-[11px] text-ink-4 tabular-nums">{relativeTime(e.timestamp, now)}</span>
                          <span className="mt-[2px]">
                            <StatusDot status={tone} size={6} />
                          </span>
                          <span className="min-w-0 flex-1 truncate text-[12px]">
                            <span style={{ color: PROVIDERS[s.provider].accent }}>{surfaceLabel(s)}</span> <span className="text-ink-2">{RESUME_VERB[e.type]}</span>
                            <span className="text-ink-3"> · {s.title}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <button className="mt-1 text-[11.5px] text-ink-3 hover:text-ink-2" onClick={() => toggleList("activity")}>
                    Open Activity
                  </button>
                </>
              )}
            </Section>

            {r.notes.length > 0 && (
              <Section title="From your notes">
                <div className="-mx-2">
                  {r.notes.map((s) => (
                    <button key={s.id} className="block w-full rounded-[7px] px-2 py-1.5 text-left hover:bg-white/[0.04]" onClick={() => select(s.id)}>
                      <span className="block truncate text-[11.5px] text-ink-3">{s.title}</span>
                      <span className="line-clamp-3 block text-[12px] leading-relaxed whitespace-pre-line text-ink-2">{s.notes}</span>
                    </button>
                  ))}
                </div>
              </Section>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

function Section({ title, meta, action, children }: { title: string; meta?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-5">
      <div className="mb-1.5 flex min-h-6 items-center justify-between">
        <h3 className="eyebrow flex items-baseline gap-2">
          {title}
          {meta && <span className="tabular-nums tracking-normal">{meta}</span>}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Click (or Enter) to edit. ⌘↵ saves, Esc cancels. Empty saves as "cleared". */
function EditableText({ value, max, label, placeholder, onSave }: { value: string; max: number; label: string; placeholder: string; onSave: (v: string) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!editing) setText(value);
  }, [value, editing]);

  const save = async () => {
    if (text.trim() === value.trim()) return setEditing(false);
    setSaving(true);
    const ok = await onSave(text.trim());
    setSaving(false);
    if (ok) setEditing(false);
  };

  if (!editing) {
    return (
      <button
        className={`group flex w-full items-start gap-1.5 rounded-[8px] px-2 py-1.5 -mx-2 text-left text-[12.5px] leading-relaxed hover:bg-white/[0.04] ${value ? "text-ink" : "text-ink-4"}`}
        onClick={() => setEditing(true)}
        aria-label={value ? `Edit ${label.toLowerCase()}` : `Add ${label.toLowerCase()}`}
      >
        <span className="min-w-0 flex-1 whitespace-pre-line">{value || placeholder}</span>
        <IconEdit size={13} className="mt-[3px] shrink-0 text-ink-4 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
      </button>
    );
  }
  return (
    <div>
      <textarea
        autoFocus
        aria-label={label}
        className="field min-h-[64px] resize-y text-[12.5px] leading-relaxed"
        placeholder={placeholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            setText(value);
            setEditing(false);
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void save();
          }
        }}
      />
      <div className="mt-1 flex items-center justify-between">
        <span className={`text-[11px] tabular-nums ${text.length > max ? "text-danger" : "text-ink-4"}`}>
          {text.length}/{max} · ⌘↵ to save
        </span>
        <span className="flex gap-1">
          <button
            className="btn btn-ghost h-6 px-2 text-[11.5px]"
            onClick={() => {
              setText(value);
              setEditing(false);
            }}
          >
            Cancel
          </button>
          <button className="btn h-6 px-2 text-[11.5px]" disabled={saving || text.length > max} onClick={() => void save()}>
            Save
          </button>
        </span>
      </div>
    </div>
  );
}

function ContinueCard({ c }: { c: ContinueWith }) {
  const s = c.session;
  const p = PROVIDERS[s.provider];
  const key = statusKey(s);
  const attention = c.kind === "needs_you";
  const color = STATUS[key].color;
  return (
    <section className="mt-5">
      <h3 className="eyebrow mb-1.5">Continue here</h3>
      <div className={`rounded-[10px] border px-3 py-2.5 ${attention ? "" : "border-line"}`} style={attention ? { borderColor: `${color}40`, background: `${color}0d` } : undefined}>
        <button className="block w-full text-left" onClick={() => enterSession(s)} title="Show on the map and inspect">
          <span className="flex items-center gap-1.5 text-[11px]">
            <GlyphIcon kind={p.glyph} color={p.accent} size={9} />
            <span style={{ color: p.accent }}>{surfaceLabel(s)}</span>
            {s.branch && <span className="truncate font-mono text-[10.5px] text-ink-4">{s.branch}</span>}
          </span>
          <span className="mt-0.5 block truncate text-[13px] text-ink">{s.title}</span>
          <span className="mt-0.5 flex items-center gap-1.5 text-[11.5px]" style={{ color: attention ? color : undefined }}>
            <StatusDot status={key} size={6} />
            <span className={attention ? "" : "text-ink-2"}>{c.why}</span>
          </span>
          {attention && s.runtime.detail && <span className="mt-0.5 block truncate pl-[18px] text-[11.5px] text-ink-3">{s.runtime.detail}</span>}
        </button>
        <button className="btn btn-primary mt-2.5 h-8 w-full justify-between px-3 text-[12.5px]" disabled={!canOpen(s)} onClick={() => void openSession(s)}>
          <span className="flex items-center gap-2">
            <IconArrowUpRight size={14} className="nudge" />
            {openDescription(s)}
          </span>
        </button>
      </div>
    </section>
  );
}

function SessionRow({ s, selected, now, links, showDetail }: { s: Session; selected: boolean; now: number; links: number; showDetail?: boolean }) {
  const p = PROVIDERS[s.provider];
  const key = statusKey(s);
  const pr = prLabel(s);
  const quiet = key === "offline" || key === "unknown";
  return (
    <div className={`group relative flex items-start gap-2 rounded-[8px] px-2 py-1.5 ${selected ? "bg-white/[0.07]" : "hover:bg-white/[0.04]"}`}>
      <span className="mt-[4px] flex w-3 justify-center">{quiet ? <GlyphIcon kind={p.glyph} color={p.accent} size={9} hollow={s.sourceMissing} /> : <StatusDot status={key} size={7} />}</span>
      <button className="min-w-0 flex-1 text-left" onClick={() => select(s.id)} onDoubleClick={() => canOpen(s) && void openSession(s)} title="Inspect · double-click to open">
        <span className="block truncate text-[12.5px] text-ink">{s.title}</span>
        <span className="flex min-w-0 items-center gap-1 text-[11px] text-ink-3">
          <span className="shrink-0" style={{ color: p.accent }}>
            {surfaceLabel(s)}
          </span>
          <span className="text-ink-4">·</span>
          {quiet ? <span className="shrink-0">{relativeTime(s.lastActivityAt, now)}</span> : <StatusLabel session={s} withReason={false} className="shrink-0" />}
          {!quiet && s.lastActivityAt && <span className="shrink-0 text-ink-4">· {relativeTime(s.lastActivityAt, now)}</span>}
        </span>
        {showDetail && (
          <span className="block truncate text-[11.5px]" style={{ color: STATUS[key].color }}>
            {isInferred(s) ? "Likely: " : ""}
            {reasonText(s)}
            {s.runtime.detail && <span className="text-ink-3"> · {s.runtime.detail}</span>}
          </span>
        )}
        {(s.branch || pr || links > 0) && (
          <span className="flex min-w-0 items-center gap-1.5 text-[10.5px] text-ink-4">
            {s.branch && <span className="truncate font-mono">{s.branch}</span>}
            {pr && <span className="shrink-0">{pr}</span>}
            {links > 0 && (
              <span className="flex shrink-0 items-center gap-0.5" title="Linked sessions">
                <IconLink size={10} /> {links}
              </span>
            )}
          </span>
        )}
        {s.notes?.trim() && <span className="block truncate text-[11px] text-ink-3 italic">“{s.notes.trim()}”</span>}
      </button>
      <button
        className="btn h-6 shrink-0 gap-1 px-1.5 text-[11px] opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100"
        disabled={!canOpen(s)}
        onClick={() => void openSession(s)}
        title={canOpen(s) ? openDescription(s) : s.source === "demo" ? "Demo sessions can’t be opened" : "Can’t be reopened"}
        aria-label={`${openDescription(s)}: ${s.title}`}
      >
        Open <IconArrowUpRight size={11} />
      </button>
    </div>
  );
}
