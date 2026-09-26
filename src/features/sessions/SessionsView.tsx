import { useMemo } from "react";
import { openSession, patchSessionsFilter, revealSession, select } from "../../app/actions";
import { UNSORTED } from "../../app/model";
import { setState, useHub, type SessionsSort } from "../../app/store";
import { IconGalaxy, IconSearch, IconStar, IconStarFilled } from "../../components/Icons";
import { MultiSelect } from "../../components/MultiSelect";
import { ageMs, relativeTime } from "../../lib/time";
import type { Provider, Session } from "../../lib/types";
import { PROVIDER_LIST, PROVIDERS, surfaceLabel } from "../../providers";
import { GlyphIcon } from "../constellation/Glyph";
import { countStatuses, STATUS, STATUS_ORDER, stateSince, statusKey, type StatusKey } from "../runtime/status";
import { StatusDot, StatusLabel } from "../runtime/StatusMark";
import { applyFilter, isFilterEmpty, projectKey, type FilterContext } from "./filter";

const RECENCY = [
  { days: null, label: "Any time" },
  { days: 1, label: "Last 24h" },
  { days: 7, label: "Last 7 days" },
  { days: 30, label: "Last 30 days" },
] as const;

/** Galaxy for understanding, Sessions for managing, ⌘K for finding. */
export function SessionsView({ insetRight }: { insetRight: number }) {
  const sessions = useHub((s) => s.data.sessions);
  const projects = useHub((s) => s.data.projects);
  const accounts = useHub((s) => s.data.accounts);
  const filter = useHub((s) => s.sessionsFilter);
  const sort = useHub((s) => s.sessionsSort);
  const selectedId = useHub((s) => s.selectedId);

  const ctx: FilterContext = useMemo(() => ({ now: Date.now(), projectNames: new Map(projects.map((p) => [p.id, p.name])) }), [projects]);
  const rows = useMemo(() => sortRows(applyFilter(sessions, filter, ctx), sort, ctx), [sessions, filter, sort, ctx]);
  // Option counts ignore the facet itself, so you can see what selecting more would add.
  const facet = (omit: keyof typeof filter) => applyFilter(sessions, { ...filter, [omit]: undefined }, ctx);
  const statusCounts = useMemo(() => countStatuses(facet("statuses")), [sessions, filter, ctx]); // eslint-disable-line react-hooks/exhaustive-deps
  const projectCounts = useMemo(() => countBy(facet("projects"), (s) => projectKey(s, ctx)), [sessions, filter, ctx]); // eslint-disable-line react-hooks/exhaustive-deps
  const providerCounts = useMemo(() => countBy(facet("providers"), (s) => s.provider), [sessions, filter, ctx]); // eslint-disable-line react-hooks/exhaustive-deps
  const accountCounts = useMemo(() => countBy(facet("accounts"), (s) => s.providerAccountId ?? ""), [sessions, filter, ctx]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = <K extends string>(field: "projects" | "providers" | "statuses" | "accounts", key: K) => {
    const cur = (filter[field] as K[] | undefined) ?? [];
    patchSessionsFilter({ [field]: cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key] });
  };

  const header = (key: SessionsSort["key"], label: string, className = "") => (
    <button
      className={`flex items-center gap-1 text-left hover:text-ink-2 ${sort.key === key ? "text-ink-2" : ""} ${className}`}
      onClick={() => setState({ sessionsSort: { key, dir: sort.key === key && sort.dir === "desc" ? "asc" : "desc" } })}
    >
      {label}
      {sort.key === key && <span className="text-ink-4">{sort.dir === "desc" ? "↓" : "↑"}</span>}
    </button>
  );

  return (
    <section
      className="panel fade-in absolute top-[52px] bottom-3 left-3 z-10 flex flex-col overflow-hidden rounded-[12px]"
      style={{ right: 12 + insetRight }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <label className="flex h-[26px] w-[240px] items-center gap-2 rounded-[7px] border border-line bg-white/[0.03] px-2 text-ink-4 focus-within:border-line-strong">
          <IconSearch size={13} />
          <input
            className="min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none placeholder:text-ink-4"
            placeholder="Filter by title, project, branch…"
            value={filter.query ?? ""}
            onChange={(e) => patchSessionsFilter({ query: e.target.value })}
            spellCheck={false}
          />
        </label>
        <MultiSelect
          label="Project"
          selected={filter.projects ?? []}
          onToggle={(k) => toggle("projects", k)}
          onClear={() => patchSessionsFilter({ projects: [] })}
          width={230}
          options={[
            ...projects.map((p) => ({ key: p.id, label: p.archivedAt ? `${p.name} (archived)` : p.name, count: projectCounts.get(p.id) ?? 0, mark: <span className="h-2 w-2 rounded-full border" style={{ borderColor: p.color ?? "#f1ead8" }} /> })),
            { key: UNSORTED, label: "Unsorted", count: projectCounts.get(UNSORTED) ?? 0 },
          ]}
        />
        <MultiSelect
          label="Provider"
          selected={filter.providers ?? []}
          onToggle={(k: Provider) => toggle("providers", k)}
          onClear={() => patchSessionsFilter({ providers: [] })}
          options={PROVIDER_LIST.map((p) => ({ key: p.id, label: p.label, count: providerCounts.get(p.id) ?? 0, mark: <GlyphIcon kind={p.glyph} color={p.accent} size={9} /> }))}
        />
        <MultiSelect
          label="Status"
          selected={filter.statuses ?? []}
          onToggle={(k: StatusKey) => toggle("statuses", k)}
          onClear={() => patchSessionsFilter({ statuses: [] })}
          options={STATUS_ORDER.map((k) => ({ key: k, label: STATUS[k].label, count: statusCounts[k], mark: <StatusDot status={k} size={7} /> }))}
        />
        {accounts.length > 1 && (
          <MultiSelect
            label="Account"
            selected={filter.accounts ?? []}
            onToggle={(k) => toggle("accounts", k)}
            onClear={() => patchSessionsFilter({ accounts: [] })}
            width={240}
            options={accounts.map((a) => ({ key: a.id, label: `${a.label}`, count: accountCounts.get(a.id) ?? 0, mark: <span className="text-[10px] text-ink-4">{a.provider === "codex" ? "Cx" : "Cl"}</span> }))}
          />
        )}
        <button
          className={`flex h-[26px] items-center gap-1 rounded-[7px] border px-2 text-[11.5px] ${filter.favoritesOnly ? "border-line-strong bg-white/[0.06] text-ink" : "border-line text-ink-3 hover:text-ink-2"}`}
          onClick={() => patchSessionsFilter({ favoritesOnly: !filter.favoritesOnly })}
          aria-pressed={!!filter.favoritesOnly}
        >
          {filter.favoritesOnly ? <IconStarFilled size={12} className="text-star" /> : <IconStar size={12} />} Favorites
        </button>
        <select
          className="h-[26px] rounded-[7px] border border-line bg-transparent px-1.5 text-[11.5px] text-ink-3 outline-none"
          value={String(filter.recentWindowDays ?? "")}
          onChange={(e) => patchSessionsFilter({ recentWindowDays: e.target.value ? Number(e.target.value) : null })}
        >
          {RECENCY.map((r) => (
            <option key={r.label} value={r.days ?? ""}>
              {r.label}
            </option>
          ))}
        </select>
        {!isFilterEmpty(filter) && (
          <button className="h-[26px] px-1.5 text-[11.5px] text-ink-3 hover:text-ink-2" onClick={() => setState({ sessionsFilter: {} })}>
            Clear filters
          </button>
        )}
        <span className="ml-auto text-[11.5px] text-ink-4 tabular-nums">
          {rows.length === sessions.length ? `${sessions.length} sessions` : `${rows.length} of ${sessions.length}`}
        </span>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_150px_120px_minmax(0,230px)_96px] gap-3 border-b border-line px-4 py-2 text-[11px] font-medium text-ink-3">
        {header("title", "Title")}
        {header("project", "Project")}
        {header("provider", "Provider")}
        {header("status", "Status")}
        {header("activity", "Last activity", "justify-end")}
      </div>
      <div className="flex-1 overflow-y-auto">
        {rows.length === 0 && <div className="px-4 py-10 text-center text-[12.5px] text-ink-3">No sessions match these filters.</div>}
        {rows.map((s) => (
          <Row
            key={s.id}
            s={s}
            project={ctx.projectNames.get(s.projectId ?? "") ?? null}
            color={projects.find((p) => p.id === s.projectId)?.color ?? null}
            archived={!!projects.find((p) => p.id === s.projectId)?.archivedAt}
            selected={s.id === selectedId}
          />
        ))}
      </div>
    </section>
  );
}

function Row({ s, project, color, archived, selected }: { s: Session; project: string | null; color: string | null; archived: boolean; selected: boolean }) {
  const p = PROVIDERS[s.provider];
  const key = statusKey(s);
  const faded = key === "offline" || key === "unknown";
  return (
    <div
      className={`group grid grid-cols-[minmax(0,1fr)_150px_120px_minmax(0,230px)_96px] items-center gap-3 border-b border-white/[0.03] px-4 py-[7px] text-[12.5px] ${
        selected ? "bg-white/[0.07]" : "hover:bg-white/[0.035]"
      }`}
      onClick={() => select(s.id)}
      onDoubleClick={() => void openSession(s)}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className={`min-w-[3.5rem] truncate ${faded ? "text-ink-2" : "text-ink"}`}>{s.title}</span>
        {s.favorite && <span className="text-[10.5px] text-star-dim">★</span>}
        {/* The branch gives way before the title does. */}
        {s.branch && <span className="min-w-0 shrink-[4] truncate font-mono text-[10.5px] text-ink-4">{s.branch}</span>}
        <button
          className="ml-auto flex shrink-0 items-center gap-1 text-[11px] text-ink-4 opacity-0 group-hover:opacity-100 hover:text-ink-2"
          onClick={(e) => {
            e.stopPropagation();
            revealSession(s);
          }}
          title="Show on map"
        >
          <IconGalaxy size={12} /> Map
        </button>
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-ink-2">
        <span className="h-2 w-2 shrink-0 rounded-full border" style={{ borderColor: color ?? "#f1ead8", borderStyle: project ? "solid" : "dashed" }} />
        <span className="truncate">{project ?? "Unsorted"}</span>
        {archived && <span className="shrink-0 text-[10.5px] text-ink-4">archived</span>}
      </span>
      <span className="flex min-w-0 items-center gap-1.5 truncate text-[12px]" style={{ color: p.accent }}>
        <GlyphIcon kind={p.glyph} color={p.accent} size={9} hollow={s.sourceMissing} />
        {surfaceLabel(s)}
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-[12px]">
        <StatusDot status={key} size={7} />
        <StatusLabel session={s} />
      </span>
      <span className="text-right text-[12px] text-ink-3 tabular-nums">{relativeTime(s.lastActivityAt)}</span>
    </div>
  );
}

function countBy<K>(list: Session[], key: (s: Session) => K): Map<K, number> {
  const m = new Map<K, number>();
  for (const s of list) m.set(key(s), (m.get(key(s)) ?? 0) + 1);
  return m;
}

function sortRows(list: Session[], sort: SessionsSort, ctx: FilterContext): Session[] {
  const now = Date.now();
  const dir = sort.dir === "desc" ? -1 : 1;
  const text = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });
  const byActivity = (a: Session, b: Session) => ageMs(b.lastActivityAt, now) - ageMs(a.lastActivityAt, now);
  const cmp: Record<SessionsSort["key"], (a: Session, b: Session) => number> = {
    title: (a, b) => text(a.title, b.title),
    project: (a, b) => text(ctx.projectNames.get(a.projectId ?? "") ?? "~", ctx.projectNames.get(b.projectId ?? "") ?? "~"),
    provider: (a, b) => PROVIDERS[a.provider].order - PROVIDERS[b.provider].order,
    // "desc" on status = most important first; then whatever has been in that state longest.
    status: (a, b) => STATUS[statusKey(b)].order - STATUS[statusKey(a)].order || ageMs(stateSince(a), now) - ageMs(stateSince(b), now),
    activity: byActivity,
  };
  const newestFirst = (a: Session, b: Session) => ageMs(a.lastActivityAt, now) - ageMs(b.lastActivityAt, now);
  return [...list].sort((a, b) => dir * cmp[sort.key](a, b) || newestFirst(a, b) || (a.id < b.id ? -1 : 1));
}
