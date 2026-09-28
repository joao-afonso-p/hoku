/**
 * The single definition of what the Galaxy shows. Every view — map, lists, counts — asks
 * here, so the map, the drawers and every count can never disagree.
 *
 * The Galaxy is a visibility model only: search (⌘K) always covers every indexed session.
 */
import { ageMs, DURATION } from "../../lib/time";
import type { Session } from "../../lib/types";
import { isLive, needsYou } from "../runtime/status";

export { isLive };

export type GalaxyMode = "current" | "all";
export const RECENT_WINDOWS = [3, 7, 14, 30] as const;
export type RecentWindowDays = (typeof RECENT_WINDOWS)[number];

export interface GalaxyVisibility {
  mode: GalaxyMode;
  recentWindowDays: RecentWindowDays;
  alwaysShowActive: boolean;
  alwaysShowFavorites: boolean;
  /**
   * Off by default: a project with nothing current stays on the map (very quiet) so its
   * position stays learnable. On: it leaves the Current Galaxy; the rest don't move.
   */
  hideInactive: boolean;
}

export const DEFAULT_VISIBILITY: GalaxyVisibility = {
  mode: "current",
  recentWindowDays: 7,
  alwaysShowActive: true,
  alwaysShowFavorites: true,
  hideInactive: false,
};

/** Settings keys in the hub DB. */
export const VISIBILITY_KEYS = {
  mode: "galaxy.mode",
  recentWindowDays: "galaxy.recentWindowDays",
  alwaysShowActive: "galaxy.alwaysShowActive",
  alwaysShowFavorites: "galaxy.alwaysShowFavorites",
  hideInactive: "galaxy.hideInactive",
} as const;

export function visibilityFromSettings(settings: Record<string, unknown>): GalaxyVisibility {
  const mode = settings[VISIBILITY_KEYS.mode];
  const days = Number(settings[VISIBILITY_KEYS.recentWindowDays]);
  const active = settings[VISIBILITY_KEYS.alwaysShowActive];
  const fav = settings[VISIBILITY_KEYS.alwaysShowFavorites];
  const hide = settings[VISIBILITY_KEYS.hideInactive];
  return {
    mode: mode === "all" || mode === "current" ? mode : DEFAULT_VISIBILITY.mode,
    recentWindowDays: (RECENT_WINDOWS as readonly number[]).includes(days) ? (days as RecentWindowDays) : DEFAULT_VISIBILITY.recentWindowDays,
    alwaysShowActive: typeof active === "boolean" ? active : DEFAULT_VISIBILITY.alwaysShowActive,
    alwaysShowFavorites: typeof fav === "boolean" ? fav : DEFAULT_VISIBILITY.alwaysShowFavorites,
    hideInactive: typeof hide === "boolean" ? hide : DEFAULT_VISIBILITY.hideInactive,
  };
}

/**
 * The timestamp recency is judged by. `lastActivityAt` comes from the provider (transcript
 * timestamps, Codex `updated_at`, Cowork `lastActivityAt`) — never from when Hoku imported it.
 * Manual sessions record when you added them, which is the best signal available for those.
 */
export function recencyTimestamp(s: Session): string | null {
  if (s.lastActivityAt) return s.lastActivityAt;
  return s.discovery === "manual" ? s.createdAt : null;
}

export function isRecent(s: Session, windowDays: number, now = Date.now()): boolean {
  return ageMs(recencyTimestamp(s), now) < windowDays * DURATION.DAY;
}

/**
 * Why a session is (or isn't) on the map. Also drives its visual treatment.
 * Runtime state and recency are separate dimensions: a live session is always shown however
 * old its last activity; an offline one only while it's recent, a favorite, or in Follow up.
 */
export type VisibilityReason = "live" | "recent" | "favorite" | "follow" | "archive" | "hidden";

export function visibilityReason(s: Session, v: GalaxyVisibility, now = Date.now()): VisibilityReason {
  // What needs you is never hidden, whatever the settings say.
  if (needsYou(s) || (v.alwaysShowActive && isLive(s))) return "live";
  if (isRecent(s, v.recentWindowDays, now)) return "recent";
  if (v.alwaysShowFavorites && s.favorite) return "favorite";
  // The user asked to come back to it, so it stays findable where they left it.
  if (s.followUp) return "follow";
  return v.mode === "all" ? "archive" : "hidden";
}

export function isSessionVisible(s: Session, v: GalaxyVisibility, now = Date.now()): boolean {
  return visibilityReason(s, v, now) !== "hidden";
}

export interface VisibleCounts {
  visible: number;
  total: number;
  live: number;
  older: number;
}

export function countVisibility(sessions: Session[], v: GalaxyVisibility, now = Date.now()): VisibleCounts {
  let visible = 0;
  let live = 0;
  for (const s of sessions) {
    if (isSessionVisible(s, v, now)) visible++;
    if (isLive(s)) live++;
  }
  return { visible, total: sessions.length, live, older: sessions.length - visible };
}

export function windowLabel(days: number): string {
  return days === 7 ? "7 days" : days === 30 ? "30 days" : `${days} days`;
}
