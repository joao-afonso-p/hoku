/**
 * The one session filter. The Galaxy puts a light UI on top of it (status only); the
 * Sessions view exposes all of it. Galaxy visibility (Current / All) is a separate, earlier
 * step: see ../galaxy/visibility.ts. Search (⌘K) deliberately uses neither.
 */
import { ageMs, DURATION } from "../../lib/time";
import type { Provider, Session } from "../../lib/types";
import { PROVIDERS, surfaceLabel } from "../../providers";
import { normalize } from "../command-palette/search";
import { statusKey, type StatusKey } from "../runtime/status";

export const UNSORTED_KEY = "unsorted";

export interface SessionFilter {
  /** Project ids; "unsorted" for sessions without one. */
  projects?: string[];
  providers?: Provider[];
  statuses?: StatusKey[];
  accounts?: string[];
  favoritesOnly?: boolean;
  /** Last activity inside this many days. null / undefined = any time. */
  recentWindowDays?: number | null;
  /** Free text; every token must match (title, project, provider, branch, folder). */
  query?: string;
}

export interface FilterContext {
  now: number;
  /** Project id → name. Sessions pointing at unknown ids count as Unsorted. */
  projectNames: Map<string, string>;
}

export function projectKey(s: Session, ctx: FilterContext): string {
  return s.projectId && ctx.projectNames.has(s.projectId) ? s.projectId : UNSORTED_KEY;
}

const some = <T,>(list: T[] | undefined): list is T[] => !!list && list.length > 0;

export function isFilterEmpty(f: SessionFilter): boolean {
  return !some(f.projects) && !some(f.providers) && !some(f.statuses) && !some(f.accounts) && !f.favoritesOnly && !f.recentWindowDays && !f.query?.trim();
}

export function matchesFilter(s: Session, f: SessionFilter, ctx: FilterContext): boolean {
  if (some(f.statuses) && !f.statuses.includes(statusKey(s))) return false;
  if (some(f.projects) && !f.projects.includes(projectKey(s, ctx))) return false;
  if (some(f.providers) && !f.providers.includes(s.provider)) return false;
  if (some(f.accounts) && !f.accounts.includes(s.providerAccountId ?? "")) return false;
  if (f.favoritesOnly && !s.favorite) return false;
  if (f.recentWindowDays && ageMs(s.lastActivityAt, ctx.now) >= f.recentWindowDays * DURATION.DAY) return false;
  const q = f.query?.trim();
  if (q) {
    const hay = normalize(
      [s.title, ctx.projectNames.get(s.projectId ?? "") ?? "unsorted", surfaceLabel(s), PROVIDERS[s.provider].label, s.branch ?? "", s.workingDirectory ?? "", s.notes ?? ""].join(" "),
    );
    if (!normalize(q).split(/\s+/).every((t) => hay.includes(t))) return false;
  }
  return true;
}

export function applyFilter(sessions: Session[], f: SessionFilter, ctx: FilterContext): Session[] {
  return isFilterEmpty(f) ? sessions : sessions.filter((s) => matchesFilter(s, f, ctx));
}
