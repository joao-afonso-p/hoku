import { useMemo } from "react";
import { clearStatusFilter, quickFilter, setVisibility, toggleStatus } from "../../app/actions";
import { type SystemModel } from "../../app/model";
import { useHub } from "../../app/store";
import { IconClose } from "../../components/Icons";
import { MultiSelect } from "../../components/MultiSelect";
import { countStatuses, STATUS, STATUS_ORDER, statusKey, type StatusKey } from "../runtime/status";
import { StatusDot } from "../runtime/StatusMark";

/**
 * The Galaxy's own controls: scope (Current | All), two quick filters that double as the
 * "what's happening now" summary, and a multi-select status filter. Filtering never moves
 * anything — non-matching sessions and projects just recede.
 */
export function GalaxyControls({ systems, left, mode, windowDays }: { systems: SystemModel[]; left: number; mode: "current" | "all"; windowDays: number }) {
  const filter = useHub((s) => s.statusFilter);
  const focus = useHub((s) => s.focus);
  const scope = useMemo(() => (focus ? systems.filter((s) => s.key === focus) : systems), [systems, focus]);
  const visible = useMemo(() => scope.flatMap((s) => s.visible), [scope]);
  const counts = useMemo(() => countStatuses(visible), [visible]);
  const matching = useMemo(() => {
    if (filter.length === 0) return null;
    let sessions = 0;
    let projects = 0;
    for (const sys of scope) {
      const n = sys.visible.filter((s) => filter.includes(statusKey(s))).length;
      sessions += n;
      if (n > 0) projects++;
    }
    return { sessions, projects };
  }, [filter, scope]);

  const quick = (key: StatusKey) => {
    const n = counts[key];
    const meta = STATUS[key];
    return (
      <button
        key={key}
        className={`flex h-[26px] items-center gap-1 rounded-[7px] px-2 text-[11.5px] whitespace-nowrap transition-colors hover:bg-white/[0.05] ${n ? "text-ink-2" : "text-ink-4"}`}
        onClick={() => quickFilter(key)}
        title={`Show only: ${meta.hint.toLowerCase()}`}
      >
        <StatusDot status={key} size={7} />
        {meta.label}
        <span className="tabular-nums" style={{ color: n && key === "needs_you" ? meta.color : undefined }}>
          {n}
        </span>
      </button>
    );
  };

  const summary = matching && describe(filter, matching.sessions, matching.projects, !!focus);

  return (
    <div className="pointer-events-none absolute top-[48px] z-20 flex items-center gap-2" style={{ left: left + 14 }}>
      <div className="pointer-events-auto flex items-center gap-2" onPointerDown={(e) => e.stopPropagation()}>
        <ModeSwitch mode={mode} windowDays={windowDays} />
        {filter.length === 0 ? (
          <div className="flex items-center rounded-[8px] border border-line bg-ground/70 p-[1px] backdrop-blur-sm">
            {quick("needs_you")}
            {quick("working")}
          </div>
        ) : null}
        <MultiSelect
          label="Status"
          selected={filter}
          onToggle={toggleStatus}
          onClear={clearStatusFilter}
          options={STATUS_ORDER.map((k) => ({ key: k, label: STATUS[k].label, count: counts[k], mark: <StatusDot status={k} size={7} /> }))}
        />
        {filter.length > 0 && (
          <>
            {STATUS_ORDER.filter((k) => filter.includes(k)).map((k) => (
              <span key={k} className="flex h-[26px] items-center gap-1 rounded-[7px] border border-line-strong bg-white/[0.05] pr-1 pl-1.5 text-[11.5px] text-ink">
                <StatusDot status={k} size={7} />
                {STATUS[k].label}
                <button className="flex h-4 w-4 items-center justify-center rounded text-ink-3 hover:bg-white/[0.08] hover:text-ink" onClick={() => toggleStatus(k)} aria-label={`Remove ${STATUS[k].label}`}>
                  <IconClose size={11} />
                </button>
              </span>
            ))}
            <button className="h-[26px] px-1.5 text-[11.5px] text-ink-3 hover:text-ink-2" onClick={clearStatusFilter}>
              Clear
            </button>
            {summary && <span className="text-[11.5px] whitespace-nowrap text-ink-3">{summary}</span>}
          </>
        )}
      </div>
    </div>
  );
}

function describe(filter: StatusKey[], sessions: number, projects: number, focused: boolean): string {
  const only = filter.length === 1 ? filter[0] : null;
  const what =
    only === "needs_you"
      ? `${sessions} ${sessions === 1 ? "session needs" : "sessions need"} you`
      : only === "working"
        ? `${sessions} working`
        : `${sessions} ${sessions === 1 ? "session" : "sessions"}`;
  if (sessions === 0) return only === "needs_you" ? "Nothing needs you" : "No matching sessions";
  return focused ? what : `${projects} ${projects === 1 ? "project" : "projects"} · ${what}`;
}

/** Compact Current | All switch. The window shows on Current so the scope is never ambiguous. */
function ModeSwitch({ mode, windowDays }: { mode: "current" | "all"; windowDays: number }) {
  const option = (value: "current" | "all", label: React.ReactNode, title: string) => (
    <button
      onClick={() => void setVisibility({ mode: value })}
      title={title}
      aria-pressed={mode === value}
      className={`h-[22px] rounded-[6px] px-2 text-[11.5px] whitespace-nowrap transition-colors ${mode === value ? "bg-white/[0.09] text-ink" : "text-ink-3 hover:text-ink-2"}`}
    >
      {label}
    </button>
  );
  return (
    <div className="flex h-[26px] items-center gap-0.5 rounded-[8px] border border-line bg-ground/70 p-[1px] backdrop-blur-sm">
      {option(
        "current",
        <>
          Current <span className={mode === "current" ? "text-ink-3" : "text-ink-4"}>· {windowDays}d</span>
        </>,
        `Live, favorites, and sessions active in the last ${windowDays} days (⌘⇧A toggles)`,
      )}
      {option("all", "All", "Every indexed session, including the archive (⌘⇧A toggles)")}
    </div>
  );
}
