import { useSyncExternalStore } from "react";
import type { FollowUpGrouping } from "../features/follow-up/followUp";
import type { SessionFilter } from "../features/sessions/filter";
import type { RecapRange } from "../features/recaps/period";
import type { StatusKey } from "../features/runtime/status";
import type { HubError, HubSnapshot, Provider, ProviderGroup, ScanReport } from "../lib/types";

export type Overlay =
  | { kind: "palette" }
  | { kind: "add-session"; projectId?: string | null }
  | { kind: "project"; projectId?: string | null }
  | { kind: "integrations" }
  | { kind: "settings" }
  | { kind: "scan" }
  | { kind: "spaces-help"; app: string };

/**
 * Drawers over the Galaxy. Needs You is the inbox for live provider blocks; Follow up is the
 * user's own review-later queue; Activity the timeline. Resume is project-scoped: it
 * describes the focused project.
 */
export type ListMode = "needs" | "follow" | "activity" | "favorites" | "projects" | "resume";
/** Full-area destinations. The Galaxy is home; Sessions is the management list; Recaps summarises a period. */
export type View = "galaxy" | "sessions" | "recaps";
export type ActivityRange = "today" | "7d" | "30d";

export interface SessionsSort {
  key: "title" | "project" | "provider" | "status" | "activity";
  dir: "asc" | "desc";
}

export interface Toast {
  id: number;
  tone: "info" | "success" | "error";
  message: string;
  detail?: string | null;
  action?: { label: string; run: () => void };
}

export interface HubState {
  loaded: boolean;
  data: HubSnapshot;
  /** null = Galaxy View, otherwise the focused project id ("unsorted" for the nebula). */
  focus: string | null;
  /** A system whose older sessions are temporarily revealed in Current mode. */
  expanded: string | null;
  /** Bumped to ask the Galaxy to re-frame everything (Galaxy button pressed again, ⌘0). */
  fitNonce: number;
  selectedId: string | null;
  overlay: Overlay | null;
  list: ListMode | null;
  view: View;
  /** Galaxy runtime filter (multi-select). Empty = no filter. Not persisted on purpose. */
  statusFilter: StatusKey[];
  /** The Sessions view's advanced filter and sort. */
  sessionsFilter: SessionFilter;
  sessionsSort: SessionsSort;
  activityRange: ActivityRange;
  activityProvider: Provider | null;
  followUpGrouping: FollowUpGrouping;
  /** Follow up drawer narrowed to one project ("unsorted" for none). null = all. */
  followUpProject: string | null;
  recapRange: RecapRange;
  /** Project ids (or "unsorted") in the recap. Empty = every project. */
  recapProjects: string[];
  toasts: Toast[];
  scanning: boolean;
  scanReport: ScanReport | null;
  integrations: ProviderGroup[] | null;
  loadError: HubError | null;
}

const empty: HubSnapshot = { projects: [], sessions: [], accounts: [], links: [], lastScans: [], settings: {}, activity: [] };

let state: HubState = {
  loaded: false,
  data: empty,
  focus: null,
  expanded: null,
  fitNonce: 0,
  selectedId: null,
  overlay: null,
  list: null,
  view: "galaxy",
  statusFilter: [],
  sessionsFilter: {},
  sessionsSort: { key: "activity", dir: "desc" },
  activityRange: "today",
  activityProvider: null,
  followUpGrouping: "date",
  followUpProject: null,
  recapRange: "7d",
  recapProjects: [],
  toasts: [],
  scanning: false,
  scanReport: null,
  integrations: null,
  loadError: null,
};

const listeners = new Set<() => void>();

export function getState(): HubState {
  return state;
}

export function setState(patch: Partial<HubState> | ((s: HubState) => Partial<HubState>)) {
  const next = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useHub<T>(selector: (s: HubState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

if (import.meta.env.DEV && typeof window !== "undefined") {
  // Handy for inspection through the dev control socket.
  (window as unknown as { __hub: () => HubState }).__hub = getState;
}
