import { useEffect, useMemo, useState } from "react";
import { enterSession, focusProject, openOverlay, openSession, setListNull } from "./drawerActions";
import { archiveProject, followUp, markActivitySeen, toggleResume, ACTIVITY_SEEN_KEY } from "../../app/actions";
import { UNSORTED, type SystemModel } from "../../app/model";
import { recencyTimestamp } from "../galaxy/visibility";
import { getState, setState, useHub, type ActivityRange, type ListMode } from "../../app/store";
import { ageMs, DURATION, relativeTime } from "../../lib/time";
import type { ActivityEvent, Project, Provider, Session } from "../../lib/types";
import { PROVIDER_LIST, PROVIDERS, surfaceLabel } from "../../providers";
import { GlyphIcon } from "../constellation/Glyph";
import { IconArchive, IconArrowUpRight, IconClose, IconEdit, IconFlag, IconFlagFilled, IconPlus, IconResume } from "../../components/Icons";
import { FollowUpDrawer } from "../follow-up/FollowUpDrawer";
import { RESUME_WIDTH } from "../resume/ResumeDrawer";
import { ATTENTION, EVENT_TONE, EVENT_VERB, isInferred, reasonText, runtimeSummary, sortNeedsYou, STATUS, stateSince, statusKey } from "../runtime/status";
import { RuntimeSummaryText, StatusDot, StatusLabel } from "../runtime/StatusMark";

export const DRAWER_WIDTH = 300;
const WIDE = 344;
export function drawerWidth(mode: ListMode): number {
  if (mode === "resume") return RESUME_WIDTH;
  return mode === "needs" || mode === "follow" || mode === "activity" ? WIDE : DRAWER_WIDTH;
}

const TITLES: Record<ListMode, string> = {
  needs: "Needs You",
  follow: "Follow up",
  activity: "Activity",
  favorites: "Favorites",
  projects: "Projects",
  resume: "Resume",
};

const RANGE_MS: Record<ActivityRange, number> = { today: 0, "7d": 7 * DURATION.DAY, "30d": 30 * DURATION.DAY };

function rangeStart(range: ActivityRange, now = Date.now()): string {
  if (range === "today") {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }
  return new Date(now - RANGE_MS[range]).toISOString();
}

/** Activity events inside the chosen range (and provider), for sessions still indexed. */
export function activityEvents(events: ActivityEvent[], sessions: Session[], range: ActivityRange, provider: Provider | null): ActivityEvent[] {
  const since = rangeStart(range);
  const known = new Set(sessions.map((s) => s.id));
  return events.filter((e) => e.timestamp >= since && known.has(e.sessionId) && (!provider || e.provider === provider));
}

/** Which sessions the canvas emphasises while a drawer is open. */
export function listHighlight(mode: ListMode, sessions: Session[], events: ActivityEvent[], range: ActivityRange, provider: Provider | null): Set<string> | null {
  switch (mode) {
    case "needs":
      return new Set(sortNeedsYou(sessions).map((s) => s.id));
    case "follow":
      return new Set(sessions.filter((s) => s.followUp).map((s) => s.id));
    case "activity":
      return new Set(activityEvents(events, sessions, range, provider).map((e) => e.sessionId));
    case "favorites":
      return new Set(sessions.filter((s) => s.favorite).map((s) => s.id));
    case "projects":
    case "resume":
      return null;
  }
}

function dayLabel(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - new Date(d).setHours(0, 0, 0, 0)) / DURATION.DAY);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** "4m", "2h", "3d": how long something has been waiting. */
function waited(iso: string | null | undefined, now = Date.now()): string {
  const a = ageMs(iso, now);
  if (!Number.isFinite(a)) return "";
  if (a < DURATION.MIN) return "now";
  if (a < DURATION.HOUR) return `${Math.floor(a / DURATION.MIN)}m`;
  if (a < DURATION.DAY) return `${Math.floor(a / DURATION.HOUR)}h`;
  return `${Math.floor(a / DURATION.DAY)}d`;
}

export function ListDrawer({ mode, systems }: { mode: ListMode; systems: SystemModel[] }) {
  const projects = useHub((s) => s.data.projects);
  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const width = drawerWidth(mode);

  return (
    <aside className="panel slide-in-left absolute top-[52px] bottom-3 left-3 z-20 flex flex-col overflow-hidden rounded-[12px]" style={{ width }} onPointerDown={(e) => e.stopPropagation()}>
      {mode === "needs" && <NeedsYou projectById={projectById} />}
      {mode === "follow" && <FollowUpDrawer projectById={projectById} header={(meta) => <Header title={TITLES.follow} meta={meta} />} />}
      {mode === "activity" && <Activity projectById={projectById} />}
      {mode === "favorites" && <Favorites projectById={projectById} />}
      {mode === "projects" && (
        <>
          <Header title={TITLES.projects}>
            <button className="btn btn-ghost h-6 px-1.5 text-[11.5px]" onClick={() => openOverlay({ kind: "project" })}>
              <IconPlus size={13} /> New
            </button>
          </Header>
          <div className="flex-1 overflow-y-auto px-1.5 pb-3">
            <ProjectList systems={systems} />
          </div>
        </>
      )}
    </aside>
  );
}

function Header({ title, meta, children }: { title: string; meta?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between px-4 pt-3.5 pb-2">
      <div className="eyebrow flex items-baseline gap-2 text-ink-2">
        {title}
        {meta}
      </div>
      <div className="flex items-center gap-1">
        {children}
        <button className="btn btn-ghost h-6 w-6 justify-center px-0 text-ink-3" onClick={setListNull} aria-label="Close">
          <IconClose size={14} />
        </button>
      </div>
    </div>
  );
}

const enter = enterSession;

/** Project name for list rows, marked when the project is archived. */
function projectLabel(project: Project | null): string {
  if (!project) return "Unsorted";
  return project.archivedAt ? `${project.name} (archived)` : project.name;
}

// ───────────── Needs You ─────────────

function NeedsYou({ projectById }: { projectById: Map<string, Project> }) {
  const sessions = useHub((s) => s.data.sessions);
  const selectedId = useHub((s) => s.selectedId);
  const list = useMemo(() => sortNeedsYou(sessions), [sessions]);
  return (
    <>
      <Header title={TITLES.needs} meta={list.length > 0 && <span className="tabular-nums tracking-normal" style={{ color: ATTENTION }}>{list.length}</span>} />
      <div className="flex-1 overflow-y-auto px-1.5 pb-3">
        {list.length === 0 ? (
          <div className="px-3 py-6 text-[12px] leading-relaxed text-ink-3">
            Nothing is waiting on you.
            <div className="mt-2 text-ink-4">
              Sessions land here when they ask for permission, ask a question or need a decision. Finished sessions don’t: they’re Ready, and show up in Activity. To come back to one later, put it in Follow up.
            </div>
          </div>
        ) : (
          list.map((s) => <NeedsRow key={s.id} s={s} project={s.projectId ? (projectById.get(s.projectId) ?? null) : null} selected={s.id === selectedId} />)
        )}
      </div>
    </>
  );
}

function NeedsRow({ s, project, selected }: { s: Session; project: Project | null; selected: boolean }) {
  const p = PROVIDERS[s.provider];
  const key = statusKey(s);
  const color = STATUS[key].color;
  return (
    <div
      className={`group relative flex w-full items-start gap-2.5 rounded-[9px] px-2.5 py-2.5 text-left transition-colors ${selected ? "bg-white/[0.07]" : "hover:bg-white/[0.04]"}`}
      onClick={() => enter(s)}
      onDoubleClick={() => void openSession(s)}
    >
      <span className="mt-[3px]">
        <StatusDot status={key} size={8} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5 text-[11px]">
          <span style={{ color: p.accent }}>{surfaceLabel(s)}</span>
          <span className="truncate text-ink-3">{projectLabel(project)}</span>
        </span>
        <span className="mt-0.5 block truncate text-[13px] text-ink">{s.title}</span>
        <span className="mt-0.5 block truncate text-[11.5px]" style={{ color }}>
          {isInferred(s) ? "Likely: " : ""}
          {reasonText(s)}
          {s.runtime.detail && <span className="text-ink-3"> · {s.runtime.detail}</span>}
        </span>
      </span>
      <span className="flex flex-col items-end gap-1.5">
        <span className="text-[11px] text-ink-3 tabular-nums" title={`Waiting since ${stateSince(s) ? new Date(stateSince(s)!).toLocaleString() : "unknown"}`}>
          {waited(stateSince(s))}
        </span>
        <button
          className="btn h-6 gap-1 px-1.5 text-[11px] opacity-0 transition-opacity group-hover:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            void openSession(s);
          }}
          title={s.provider === "claude-code" ? "Go to terminal" : "Open the session"}
        >
          Open <IconArrowUpRight size={11} />
        </button>
      </span>
    </div>
  );
}

// ───────────── Activity ─────────────

function Activity({ projectById }: { projectById: Map<string, Project> }) {
  const events = useHub((s) => s.data.activity);
  const sessions = useHub((s) => s.data.sessions);
  const range = useHub((s) => s.activityRange);
  const provider = useHub((s) => s.activityProvider);
  const selectedId = useHub((s) => s.selectedId);
  const byId = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);
  const list = useMemo(() => activityEvents(events, sessions, range, provider), [events, sessions, range, provider]);

  // What was new when the drawer opened stays marked while it's open.
  const [seenAt] = useState(() => {
    const v = getState().data.settings[ACTIVITY_SEEN_KEY];
    return typeof v === "string" ? v : null;
  });
  useEffect(() => {
    void markActivitySeen();
  }, []);
  const fresh = seenAt ? list.filter((e) => e.timestamp > seenAt && e.type === "became_ready").length : 0;

  const seg = (value: ActivityRange, label: string) => (
    <button
      key={value}
      className={`h-[20px] rounded-[5px] px-1.5 text-[11px] ${range === value ? "bg-white/[0.09] text-ink" : "text-ink-3 hover:text-ink-2"}`}
      onClick={() => setState({ activityRange: value })}
    >
      {label}
    </button>
  );

  return (
    <>
      <Header title={TITLES.activity} />
      <div className="flex items-center gap-2 px-4 pb-2">
        <div className="flex items-center gap-0.5 rounded-[7px] border border-line p-[1px]">
          {seg("today", "Today")}
          {seg("7d", "7d")}
          {seg("30d", "30d")}
        </div>
        <select
          className="h-[22px] rounded-[6px] border border-line bg-transparent px-1 text-[11px] text-ink-3 outline-none"
          value={provider ?? ""}
          onChange={(e) => setState({ activityProvider: (e.target.value || null) as Provider | null })}
        >
          <option value="">All providers</option>
          {PROVIDER_LIST.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        {fresh > 0 && <span className="ml-auto text-[11px] text-ink-3">{fresh} finished since you last checked</span>}
      </div>
      <div className="flex-1 overflow-y-auto px-1.5 pb-3">
        {list.length === 0 ? (
          <div className="px-3 py-6 text-[12px] leading-relaxed text-ink-3">
            {range === "today" ? "Nothing has happened today yet." : "No activity in this range."}
            <div className="mt-2 text-ink-4">Hoku records when sessions start working, need you, finish, fail or go offline. Individual tool calls aren’t recorded.</div>
          </div>
        ) : (
          list.map((e, i) => {
            const header = i === 0 || dayLabel(list[i - 1].timestamp) !== dayLabel(e.timestamp) ? dayLabel(e.timestamp) : null;
            const s = byId.get(e.sessionId);
            if (!s) return null;
            return (
              <div key={e.id}>
                {header && <div className="eyebrow px-2.5 pt-3 pb-1">{header}</div>}
                <EventRow e={e} s={s} project={s.projectId ? (projectById.get(s.projectId) ?? null) : null} selected={s.id === selectedId} fresh={!!seenAt && e.timestamp > seenAt} />
              </div>
            );
          })
        )}
      </div>
    </>
  );
}

function EventRow({ e, s, project, selected, fresh }: { e: ActivityEvent; s: Session; project: Project | null; selected: boolean; fresh: boolean }) {
  const p = PROVIDERS[e.provider];
  const tone = EVENT_TONE[e.type];
  const loud = tone === "needs_you" || tone === "error";
  return (
    <div className={`group relative flex items-start rounded-[8px] transition-colors ${selected ? "bg-white/[0.07]" : "hover:bg-white/[0.04]"}`}>
      <button
        className="flex min-w-0 flex-1 items-start gap-2.5 px-2.5 py-1.5 text-left"
        onClick={() => enter(s)}
        onDoubleClick={() => void openSession(s)}
      >
        <span className="w-[38px] shrink-0 pt-[1px] text-[11px] text-ink-4 tabular-nums">{clock(e.timestamp)}</span>
        <span className="mt-[2px]">
          <StatusDot status={tone} size={7} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px]">
            <span style={{ color: p.accent }}>{surfaceLabel(s)}</span>{" "}
            <span style={{ color: loud ? STATUS[tone].color : undefined }} className={loud ? "" : "text-ink-2"}>
              {EVENT_VERB[e.type]}
            </span>
            {fresh && e.type === "became_ready" && <span className="ml-1.5 text-[10.5px] text-ink-3">new</span>}
          </span>
          <span className="block truncate text-[11.5px] text-ink-3">
            {projectLabel(project)} · {s.title}
          </span>
          {e.reason && (e.type === "needs_input" || e.type === "error") && <span className="block truncate text-[11px] text-ink-4">{e.reason}</span>}
        </span>
      </button>
      {s.followUp ? (
        <span className="mt-[7px] mr-2.5 text-ink-3" title="In Follow up">
          <IconFlagFilled size={12} />
        </span>
      ) : (
        <button
          className="mt-[3px] mr-1.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] text-ink-4 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-white/[0.06] hover:text-ink-2 focus-visible:opacity-100"
          onClick={() => void followUp(s)}
          title="Follow up: review this session later (F)"
          aria-label="Follow up"
        >
          <IconFlag size={12} />
        </button>
      )}
    </div>
  );
}

// ───────────── Favorites ─────────────

function Favorites({ projectById }: { projectById: Map<string, Project> }) {
  const sessions = useHub((s) => s.data.sessions);
  const selectedId = useHub((s) => s.selectedId);
  const list = useMemo(() => sessions.filter((s) => s.favorite).sort((a, b) => ageMs(recencyTimestamp(a)) - ageMs(recencyTimestamp(b))), [sessions]);
  return (
    <>
      <Header title={TITLES.favorites} />
      <div className="flex-1 overflow-y-auto px-1.5 pb-3">
        {list.length === 0 ? (
          <div className="px-3 py-6 text-[12px] leading-relaxed text-ink-3">
            Star a session in its inspector to keep it here, however old or offline it gets.
            <div className="mt-2 text-ink-4">Want to review something later and then be done with it? Use Follow up instead.</div>
          </div>
        ) : (
          list.map((s) => <SessionRow key={s.id} s={s} project={s.projectId ? (projectById.get(s.projectId) ?? null) : null} selected={s.id === selectedId} />)
        )}
      </div>
    </>
  );
}

function SessionRow({ s, project, selected }: { s: Session; project: Project | null; selected: boolean }) {
  const p = PROVIDERS[s.provider];
  const key = statusKey(s);
  const quiet = key === "offline" || key === "unknown";
  return (
    <button
      className={`flex w-full items-start gap-2.5 rounded-[8px] px-2.5 py-2 text-left transition-colors ${selected ? "bg-white/[0.07]" : "hover:bg-white/[0.04]"}`}
      onClick={() => enter(s)}
      onDoubleClick={() => void openSession(s)}
    >
      <span className="mt-[4px] flex w-3 justify-center">{quiet ? <GlyphIcon kind={p.glyph} color={p.accent} size={9} /> : <StatusDot status={key} size={7} />}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] text-ink">{s.title}</span>
        <span className="block truncate text-[11px] text-ink-3">
          <span style={{ color: p.accent }}>{surfaceLabel(s)}</span> · {projectLabel(project)} ·{" "}
          {quiet ? relativeTime(s.lastActivityAt) : <StatusLabel session={s} withReason={false} />}
        </span>
      </span>
    </button>
  );
}

// ───────────── Projects ─────────────

function ProjectList({ systems }: { systems: SystemModel[] }) {
  const focus = useHub((s) => s.focus);
  const archived = useHub((s) => s.data.projects).filter((p) => p.archivedAt);
  return (
    <>
      {systems.map((sys) => {
        const summary = runtimeSummary(sys.runtime);
        return (
          <div key={sys.key} className={`group flex items-center gap-2.5 rounded-[8px] px-2.5 py-2 ${focus === sys.key ? "bg-white/[0.07]" : "hover:bg-white/[0.04]"}`}>
            <span className="h-2.5 w-2.5 rounded-full border" style={{ borderColor: sys.color ?? "#f1ead8", borderStyle: sys.key === UNSORTED ? "dashed" : "solid" }} />
            <button className="min-w-0 flex-1 text-left" onClick={() => focusProject(sys.key, false)}>
              <span className="block truncate text-[12.5px] text-ink">{sys.name}</span>
              <span className="block text-[11px] text-ink-3">
                {sys.counts.visible} current · {sys.counts.total} total
                {sys.project?.rootPath && <span className="text-ink-4"> · {sys.project.rootPath.split("/").pop()}</span>}
              </span>
              {summary && (
                <span className="block text-[11px]">
                  <RuntimeSummaryText counts={sys.runtime} />
                </span>
              )}
            </button>
            {sys.project && (
              <span className="flex items-center gap-1.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
                <button className="text-ink-4 hover:text-ink-2" onClick={() => toggleResume(sys.project!.id)} title="Resume: what this project is, what changed, where to continue" aria-label="Resume project">
                  <IconResume size={13} />
                </button>
                <button className="text-ink-4 hover:text-ink-2" onClick={() => void archiveProject(sys.project!.id, true)} title="Archive: hide from the Galaxy, keep everything" aria-label="Archive project">
                  <IconArchive size={13} />
                </button>
                <button className="text-ink-4 hover:text-ink-2" onClick={() => openOverlay({ kind: "project", projectId: sys.project!.id })} title="Edit project" aria-label="Edit project">
                  <IconEdit size={13} />
                </button>
              </span>
            )}
          </div>
        );
      })}
      {archived.length > 0 && <ArchivedProjects projects={archived} />}
    </>
  );
}

/** Archived projects: off the map, one click from coming back exactly where they were. */
function ArchivedProjects({ projects }: { projects: Project[] }) {
  const [open, setOpen] = useState(false);
  const sessions = useHub((s) => s.data.sessions);
  return (
    <div className="mt-2 border-t border-line pt-2">
      <button className="eyebrow flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left hover:text-ink-2" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={`inline-block transition-transform ${open ? "rotate-90" : ""}`}>›</span> Archived <span className="tracking-normal text-ink-4">{projects.length}</span>
      </button>
      {open &&
        projects.map((p) => (
          <div key={p.id} className="group flex items-center gap-2.5 rounded-[8px] px-2.5 py-1.5 hover:bg-white/[0.04]">
            <span className="h-2.5 w-2.5 rounded-full border opacity-50" style={{ borderColor: p.color ?? "#f1ead8" }} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px] text-ink-2">{p.name}</span>
              <span className="block text-[11px] text-ink-4">{sessions.filter((s) => s.projectId === p.id).length} sessions · searchable in ⌘K and Sessions</span>
            </span>
            <button className="btn h-6 px-2 text-[11px]" onClick={() => void archiveProject(p.id, false)}>
              Restore
            </button>
          </div>
        ))}
    </div>
  );
}
