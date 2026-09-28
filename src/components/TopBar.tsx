import { useMemo } from "react";
import { ACTIVITY_SEEN_KEY, focusProject, openOverlay, scan, toggleExpanded, toggleList, toggleResume } from "../app/actions";
import { useVisibility, type SystemModel } from "../app/model";
import { useHub } from "../app/store";
import mark from "../assets/hoku-mark-96.png";
import { ageMs, DURATION, relativeTime } from "../lib/time";
import { IconChevronLeft, IconPlus, IconResume, IconScan, IconSearch } from "./Icons";
import { countLabel } from "../features/constellation/Constellation";
import { runtimeSummary } from "../features/runtime/status";
import { RuntimeSummaryText, StatusDot } from "../features/runtime/StatusMark";

/**
 * Sessions that finished since Activity was last opened (or in the last day). Ready is news,
 * not an inbox item, so it's a quiet count here and never a badge.
 */
export function useFinishedSince(): number {
  const events = useHub((s) => s.data.activity);
  const seen = useHub((s) => s.data.settings[ACTIVITY_SEEN_KEY]);
  return useMemo(() => {
    const since = typeof seen === "string" ? seen : new Date(Date.now() - DURATION.DAY).toISOString();
    return new Set(events.filter((e) => e.type === "became_ready" && e.timestamp > since).map((e) => e.sessionId)).size;
  }, [events, seen]);
}

export function TopBar({ systems }: { systems: SystemModel[] }) {
  const focus = useHub((s) => s.focus);
  const view = useHub((s) => s.view);
  const list = useHub((s) => s.list);
  const sessions = useHub((s) => s.data.sessions);
  const lastScans = useHub((s) => s.data.lastScans);
  const scanning = useHub((s) => s.scanning);
  const v = useVisibility();
  const focused = focus && view === "galaxy" ? systems.find((s) => s.key === focus) : null;
  const finished = useFinishedSince();

  const today = sessions.filter((s) => ageMs(s.lastActivityAt) < DURATION.DAY).length;
  const lastScan = lastScans.map((s) => s.finishedAt).sort().pop();
  const focusRuntime = focused ? runtimeSummary(focused.runtime) : "";

  return (
    <header data-tauri-drag-region className="absolute inset-x-0 top-0 z-30 flex h-[44px] items-center gap-3 pr-4 pl-[34px]">
      <div data-tauri-drag-region className="flex min-w-0 flex-1 items-center gap-2">
        {focused ? (
          <>
            <button className="btn btn-ghost h-7 gap-1 px-1.5 text-ink-3" onClick={() => focusProject(null)}>
              <IconChevronLeft size={14} /> Galaxy
            </button>
            <span className="text-ink-4">/</span>
            <span className="max-w-[240px] shrink-0 truncate text-[12.5px] font-semibold tracking-[0.12em] text-ink uppercase">{focused.name}</span>
            <span className="min-w-0 truncate text-[12px] whitespace-nowrap text-ink-3">
              {focusRuntime && (
                <>
                  <RuntimeSummaryText counts={focused.runtime} /> ·{" "}
                </>
              )}
              {countLabel(focused, v.mode)}
            </span>
            {v.mode === "current" && (focused.counts.older > 0 || focused.expanded) && (
              <button
                className="btn btn-ghost h-6 px-1.5 text-[11.5px] whitespace-nowrap text-ink-3"
                onClick={() => toggleExpanded(focused.key)}
                title="Temporarily show this project's older sessions"
              >
                {focused.expanded ? "Hide older" : `+${focused.counts.older} older`}
              </button>
            )}
            {focused.project && (
              <button
                className={`btn h-6 px-2 text-[11.5px] ${list === "resume" ? "bg-white/[0.08] text-ink" : ""}`}
                onClick={() => toggleResume(focused.project!.id)}
                aria-pressed={list === "resume"}
                title="Resume: what this project is, what changed, what needs you, where to continue (R)"
              >
                <IconResume size={13} /> Resume
              </button>
            )}
            {focused.project && (
              <button className="btn btn-ghost h-6 px-1.5 text-[11.5px] text-ink-4" onClick={() => openOverlay({ kind: "project", projectId: focused.project!.id })}>
                Edit
              </button>
            )}
          </>
        ) : (
          <span data-tauri-drag-region className="flex items-center gap-2">
            <img src={mark} alt="" className="pointer-events-none h-[22px] w-[22px]" draggable={false} />
            <span className="text-[13px] font-semibold tracking-[0.02em] text-ink">Hoku</span>
            {view === "sessions" && (
              <>
                <span className="text-ink-4">/</span>
                <span className="text-[12.5px] font-semibold tracking-[0.12em] text-ink uppercase">Sessions</span>
              </>
            )}
          </span>
        )}
      </div>

      <button
        className="flex h-[28px] w-[280px] items-center gap-2 rounded-[8px] border border-line bg-white/[0.03] px-2.5 text-[12.5px] text-ink-4 transition-colors hover:border-line-strong hover:text-ink-3"
        onClick={() => openOverlay({ kind: "palette" })}
      >
        <IconSearch size={14} />
        <span className="flex-1 text-left">Search all sessions…</span>
        <span className="kbd">⌘K</span>
      </button>

      <div data-tauri-drag-region className="flex flex-1 items-center justify-end gap-3">
        {finished > 0 && (
          <button className="flex items-center gap-1 text-[11.5px] whitespace-nowrap text-ink-2 hover:text-ink" onClick={() => toggleList("activity")} title="Finished since you last opened Activity">
            <StatusDot status="ready" size={7} /> {finished} finished
          </button>
        )}
        <button className="flex items-center gap-3 text-[11.5px] whitespace-nowrap text-ink-3 hover:text-ink-2" onClick={() => openOverlay({ kind: "integrations" })} title="Integrations">
          <span>{today} today</span>
          <span className="text-ink-4">{scanning ? "scanning…" : lastScan ? `scanned ${relativeTime(lastScan)}` : "not scanned"}</span>
        </button>
        <button className="btn h-7 w-7 justify-center px-0" onClick={() => openOverlay({ kind: "add-session", projectId: focus })} title="Add session (⌘N)">
          <IconPlus size={14} />
        </button>
        <button className="btn h-7 px-2.5" disabled={scanning} onClick={() => void scan()} title="Scan for sessions (⌘⇧S)">
          <IconScan size={14} /> Scan
        </button>
      </div>
    </header>
  );
}
