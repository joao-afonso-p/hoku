import { useMemo } from "react";
import { galaxySpacing, layoutSystem, slotPosition, weightFromMetadata, type SystemLayout, type Zone } from "../features/constellation/layout";
import { countStatuses, statusKey, type StatusKey } from "../features/runtime/status";
import {
  countVisibility,
  recencyTimestamp,
  visibilityFromSettings,
  visibilityReason,
  type GalaxyVisibility,
  type VisibleCounts,
} from "../features/galaxy/visibility";
import { ageMs, DURATION } from "../lib/time";
import type { HubSnapshot, Project, Session } from "../lib/types";
import { useHub } from "./store";
import { useMinuteClock } from "./useClock";

export const UNSORTED = "unsorted";

export function isArchived(p: Project | null | undefined): boolean {
  return !!p?.archivedAt;
}

/**
 * Where a session lives on the map: its project, Unsorted, or nowhere (its project is
 * archived — the session stays searchable and openable, just not drawn).
 */
export function mapKey(s: Session, projects: Project[]): string | null {
  if (!s.projectId) return UNSORTED;
  const p = projects.find((x) => x.id === s.projectId);
  if (!p) return UNSORTED;
  return isArchived(p) ? null : p.id;
}

export interface SystemModel {
  key: string;
  name: string;
  color: string | null;
  project: Project | null;
  x: number;
  y: number;
  /** Every session in the project (for counts and lists). */
  sessions: Session[];
  /** What the map draws under the current visibility. */
  visible: Session[];
  counts: VisibleCounts;
  layout: SystemLayout;
  /** Runtime counts over every session in the project (not just the visible ones). */
  runtime: Record<StatusKey, number>;
  isDemo: boolean;
  /** Older sessions of this project are temporarily revealed in Current mode. */
  expanded: boolean;
}

const ZONE_OF = { live: 0, recent: 1, favorite: 2, archive: 2, hidden: 2 } as const;

/** Radius inside the Live zone: what needs you sits closest to the core. */
const URGENCY: Record<StatusKey, number> = { needs_you: 0.08, error: 0.24, working: 0.45, ready: 0.72, idle: 1, offline: 0.9, unknown: 0.9 };

export function buildSystems(data: HubSnapshot, now: number, v: GalaxyVisibility, expandedKey: string | null): SystemModel[] {
  const byProject = new Map<string, Session[]>();
  const known = new Set(data.projects.map((p) => p.id));
  const archived = new Set(data.projects.filter(isArchived).map((p) => p.id));
  for (const s of data.sessions) {
    if (s.projectId && archived.has(s.projectId)) continue;
    const key = s.projectId && known.has(s.projectId) ? s.projectId : UNSORTED;
    const list = byProject.get(key) ?? [];
    list.push(s);
    byProject.set(key, list);
  }

  const windowMs = v.recentWindowDays * DURATION.DAY;
  const prepared = (key: string) => {
    const sessions = byProject.get(key) ?? [];
    const expanded = key === expandedKey;
    const effective: GalaxyVisibility = expanded ? { ...v, mode: "all" } : v;
    const visible = sessions.filter((s) => visibilityReason(s, effective, now) !== "hidden");
    const layout = layoutSystem(
      key,
      visible.map((s) => ({
        id: s.id,
        provider: s.provider,
        zone: ZONE_OF[visibilityReason(s, effective, now)] as Zone,
        recency: Math.min(1, ageMs(recencyTimestamp(s), now) / windowMs),
        urgency: URGENCY[statusKey(s)],
        favorite: s.favorite,
        weight: weightFromMetadata(s.metadata),
      })),
    );
    return { sessions, visible, layout, expanded, counts: countVisibility(sessions, v, now) };
  };

  // Archived projects keep their slot (restoring puts them back in place); they just aren't drawn.
  const entries = data.projects.filter((p) => !isArchived(p)).map((p) => ({ key: p.id, name: p.name, project: p as Project | null, slot: p.slot, ...prepared(p.id) }));
  if ((byProject.get(UNSORTED)?.length ?? 0) > 0) {
    // Unsorted takes the spiral position after the last project: present, never central.
    const maxSlot = data.projects.reduce((m, p) => Math.max(m, p.slot), 0);
    entries.push({ key: UNSORTED, name: "Unsorted", project: null, slot: maxSlot + 1, ...prepared(UNSORTED) });
  }

  // One uniform spacing for the whole spiral, sized to the largest visible system.
  const spacing = galaxySpacing(Math.max(0, ...entries.filter((e) => e.key !== UNSORTED).map((e) => e.layout.extent)));

  return entries.map((e) => {
    const pos = slotPosition(e.slot, e.key, spacing);
    return {
      key: e.key,
      name: e.name,
      color: e.project?.color ?? null,
      project: e.project,
      x: pos.x,
      y: pos.y,
      sessions: e.sessions,
      visible: e.visible,
      counts: e.counts,
      layout: e.layout,
      runtime: countStatuses(e.sessions),
      isDemo: e.project?.isDemo ?? false,
      expanded: e.expanded,
    };
  });
}

export function useVisibility(): GalaxyVisibility {
  const settings = useHub((s) => s.data.settings);
  return useMemo(() => visibilityFromSettings(settings), [settings]);
}

/**
 * With "Hide inactive projects" on (Current only), projects with nothing on the map leave it.
 * Everyone else keeps their slot, so nothing reshuffles. The focused or expanded project
 * always stays.
 */
export function visibleSystems(systems: SystemModel[], v: GalaxyVisibility, keep: (string | null)[]): SystemModel[] {
  if (!v.hideInactive || v.mode === "all") return systems;
  return systems.filter((s) => s.visible.length > 0 || keep.includes(s.key));
}

export function useSystems(): SystemModel[] {
  const data = useHub((s) => s.data);
  const expanded = useHub((s) => s.expanded);
  const focus = useHub((s) => s.focus);
  const v = useVisibility();
  const now = useMinuteClock();
  const all = useMemo(() => buildSystems(data, now, v, expanded), [data, now, v, expanded]);
  return useMemo(() => visibleSystems(all, v, [focus, expanded]), [all, v, focus, expanded]);
}

export function useSession(id: string | null): Session | null {
  const sessions = useHub((s) => s.data.sessions);
  return useMemo(() => (id ? (sessions.find((x) => x.id === id) ?? null) : null), [sessions, id]);
}

export function useProjectLookup(): (id: string | null | undefined) => Project | null {
  const projects = useHub((s) => s.data.projects);
  return useMemo(() => {
    const m = new Map(projects.map((p) => [p.id, p]));
    return (id) => (id ? (m.get(id) ?? null) : null);
  }, [projects]);
}

export { isLive } from "../features/runtime/status";
