import { useMemo } from "react";
import { followUpDone, openSession } from "../../app/actions";
import { UNSORTED } from "../../app/model";
import { setState, useHub } from "../../app/store";
import { useMinuteClock } from "../../app/useClock";
import { IconArrowUpRight, IconCheck, IconClock } from "../../components/Icons";
import type { Project, Session } from "../../lib/types";
import { PROVIDERS, surfaceLabel } from "../../providers";
import { enterSession } from "../activity/drawerActions";
import { statusKey } from "../runtime/status";
import { StatusDot, StatusLabel } from "../runtime/StatusMark";
import { DueMenu } from "./DueMenu";
import { addedLabel, dueCount, dueLabel, followUpKey, groupFollowUps, OVERDUE, openedSince, queued, type FollowUpGrouping, type Queued } from "./followUp";

function projectKeyOf(s: Session, projectById: Map<string, Project>): string {
  return s.projectId && projectById.has(s.projectId) ? s.projectId : UNSORTED;
}

function projectName(key: string, projectById: Map<string, Project>): string {
  const p = projectById.get(key);
  if (!p) return "Unsorted";
  return p.archivedAt ? `${p.name} (archived)` : p.name;
}

/** The review-later queue. Only what the user put here; Ready sessions never land here on their own. */
export function FollowUpDrawer({ projectById, header }: { projectById: Map<string, Project>; header: (meta: React.ReactNode) => React.ReactNode }) {
  const sessions = useHub((s) => s.data.sessions);
  const selectedId = useHub((s) => s.selectedId);
  const grouping = useHub((s) => s.followUpGrouping);
  const project = useHub((s) => s.followUpProject);
  const now = useMinuteClock();

  const all = useMemo(() => queued(sessions), [sessions]);
  const projects = useMemo(() => {
    const keys = [...new Set(all.map((s) => projectKeyOf(s, projectById)))];
    return keys.map((key) => ({ key, label: projectName(key, projectById) })).sort((a, b) => (a.key === UNSORTED ? 1 : b.key === UNSORTED ? -1 : a.label.localeCompare(b.label)));
  }, [all, projectById]);
  // A filter on a project that no longer has follow-ups would hide everything.
  const filter = project && projects.some((p) => p.key === project) ? project : null;
  const list = useMemo(() => (filter ? all.filter((s) => projectKeyOf(s, projectById) === filter) : all), [all, filter, projectById]);
  const groups = useMemo(
    () => groupFollowUps(list, grouping, (s) => ({ key: projectKeyOf(s, projectById), label: projectName(projectKeyOf(s, projectById), projectById) }), now),
    [list, grouping, projectById, now],
  );
  const due = dueCount(all, now);

  const seg = (value: FollowUpGrouping, label: string) => (
    <button
      key={value}
      className={`h-[20px] rounded-[5px] px-1.5 text-[11px] ${grouping === value ? "bg-white/[0.09] text-ink" : "text-ink-3 hover:text-ink-2"}`}
      onClick={() => setState({ followUpGrouping: value })}
      aria-pressed={grouping === value}
    >
      {label}
    </button>
  );

  return (
    <>
      {header(
        all.length > 0 && (
          <span className="tracking-normal normal-case tabular-nums">
            {all.length}
            {due > 0 && <span className="text-ink-3"> · {due} due</span>}
          </span>
        ),
      )}
      {all.length > 0 && (
        <div className="flex items-center gap-2 px-4 pb-2">
          <div className="flex items-center gap-0.5 rounded-[7px] border border-line p-[1px]" role="group" aria-label="Group by">
            {seg("date", "By date")}
            {seg("project", "By project")}
          </div>
          {projects.length > 1 && (
            <select
              className="h-[22px] min-w-0 flex-1 rounded-[6px] border border-line bg-transparent px-1 text-[11px] text-ink-3 outline-none"
              value={filter ?? ""}
              onChange={(e) => setState({ followUpProject: e.target.value || null })}
              aria-label="Project"
            >
              <option value="">All projects</option>
              {projects.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
      <div className="flex-1 overflow-y-auto px-1.5 pb-3">
        {all.length === 0 ? (
          <div className="px-3 py-6 text-[12px] leading-relaxed text-ink-3">
            Nothing to follow up on.
            <div className="mt-2 text-ink-4">
              Finished a session you want to review later? Select it and press <span className="kbd">F</span>, or use Follow up in its inspector, in Activity or in Sessions. Add a reminder if it should come back at a certain time.
            </div>
            <div className="mt-2 text-ink-4">Nothing lands here on its own. Sessions waiting on a permission or an answer are in Needs You.</div>
          </div>
        ) : (
          groups.map((g) => (
            <section key={g.key} aria-label={g.label}>
              <div className="eyebrow flex items-center gap-1.5 px-2.5 pt-3 pb-1">
                {grouping === "project" && (
                  <span className="h-2 w-2 rounded-full border" style={{ borderColor: projectById.get(g.key)?.color ?? "#f1ead8", borderStyle: g.key === UNSORTED ? "dashed" : "solid" }} />
                )}
                <span className="truncate">{g.label}</span>
                <span className="tracking-normal text-ink-4">{g.items.length}</span>
              </div>
              {g.items.map((s) => (
                <FollowRow key={s.id} s={s} project={grouping === "date" ? projectName(projectKeyOf(s, projectById), projectById) : null} selected={s.id === selectedId} now={now} />
              ))}
            </section>
          ))
        )}
      </div>
    </>
  );
}

function FollowRow({ s, project, selected, now }: { s: Queued; project: string | null; selected: boolean; now: number }) {
  const p = PROVIDERS[s.provider];
  const key = followUpKey(s.followUp, now);
  const dueColor = key === "overdue" ? OVERDUE : key === "due" ? "var(--color-star)" : undefined;
  const action = "btn h-6 w-6 justify-center px-0 text-ink-3 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100";
  return (
    <div className={`group relative flex w-full items-start gap-2.5 rounded-[9px] px-2.5 py-2 transition-colors ${selected ? "bg-white/[0.07]" : "hover:bg-white/[0.04]"}`}>
      <span className="mt-[3px]">
        <StatusDot status={statusKey(s)} size={7} />
      </span>
      <button className="min-w-0 flex-1 text-left" onClick={() => enterSession(s)} onDoubleClick={() => void openSession(s)} title="Click to inspect, double-click to open">
        <span className="flex items-baseline gap-1.5 text-[11px]">
          <span style={{ color: p.accent }}>{surfaceLabel(s)}</span>
          {project && <span className="truncate text-ink-3">{project}</span>}
        </span>
        <span className="mt-0.5 block truncate text-[13px] text-ink">{s.title}</span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1 text-[11.5px]">
          <span className={`shrink-0 tabular-nums ${dueColor ? "" : "text-ink-3"}`} style={{ color: dueColor }} title={s.followUp.dueAt ? new Date(s.followUp.dueAt).toLocaleString() : undefined}>
            {dueLabel(s.followUp, now)}
          </span>
          <span className="text-ink-4">·</span>
          <StatusLabel session={s} withReason={false} className="shrink-0" />
          <span className="truncate text-ink-4">· {openedSince(s) ? "opened since" : addedLabel(s.followUp, now)}</span>
        </span>
      </button>
      <span className="flex shrink-0 items-center gap-1 pt-[1px]">
        <DueMenu session={s} className={action} title="Remind me later">
          <IconClock size={13} />
        </DueMenu>
        <button className={action} onClick={() => void followUpDone(s)} title="Done (F)" aria-label="Done">
          <IconCheck size={13} />
        </button>
        <button className={action} onClick={() => void openSession(s)} title={s.provider === "claude-code" ? "Go to terminal" : "Open the session"} aria-label="Open">
          <IconArrowUpRight size={13} />
        </button>
      </span>
    </div>
  );
}
