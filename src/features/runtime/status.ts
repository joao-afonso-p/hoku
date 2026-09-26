/**
 * Runtime state semantics for the UI. The backend decides the state (src-tauri/src/runtime.rs);
 * this module is the one place that decides what it *means*: priority, the Needs You rule,
 * labels and colour. Every view asks here.
 *
 * Needs You ≠ Ready: a finished session is "ready", never an inbox item.
 */
import { ageMs } from "../../lib/time";
import type { ActivityEventType, RuntimeState, Session } from "../../lib/types";

/**
 * One key per session, so counts partition cleanly: "needs_you" is needs_input plus errors
 * that need a human; "error" is every other error.
 */
export type StatusKey = "needs_you" | "error" | "working" | "ready" | "idle" | "offline" | "unknown";

export interface StatusMeta {
  key: StatusKey;
  label: string;
  /** Lower = more important. Also the visual priority order. */
  order: number;
  /** Used sparingly: halos, glyphs, micro-labels. Never large fills. */
  color: string;
  hint: string;
}

export const ATTENTION = "#f2bf4d";
export const CORAL = "#de8f7d";
export const STARLIGHT = "#f1ead8";
export const SAGE = "#a9c2a0";

export const STATUS: Record<StatusKey, StatusMeta> = {
  needs_you: { key: "needs_you", label: "Needs You", order: 0, color: ATTENTION, hint: "Waiting for your permission, answer or confirmation" },
  error: { key: "error", label: "Error", order: 1, color: CORAL, hint: "The last turn failed" },
  working: { key: "working", label: "Working", order: 2, color: STARLIGHT, hint: "Generating or running tools right now" },
  ready: { key: "ready", label: "Ready", order: 3, color: SAGE, hint: "Finished its turn recently — ready for a new prompt" },
  idle: { key: "idle", label: "Idle", order: 4, color: "#8b9099", hint: "Open, nothing happening" },
  offline: { key: "offline", label: "Offline", order: 5, color: "#5d626b", hint: "No live process" },
  unknown: { key: "unknown", label: "Unknown", order: 6, color: "#6b7079", hint: "The provider doesn't expose live state" },
};

export const STATUS_ORDER: StatusKey[] = (Object.values(STATUS) as StatusMeta[]).sort((a, b) => a.order - b.order).map((m) => m.key);

export function needsYou(s: Session): boolean {
  return s.runtime.state === "needs_input" || (s.runtime.state === "error" && s.runtime.actionRequired);
}

export function statusKey(s: Session): StatusKey {
  return needsYou(s) ? "needs_you" : (s.runtime.state as Exclude<RuntimeState, "needs_input">);
}

export function statusMeta(s: Session): StatusMeta {
  return STATUS[statusKey(s)];
}

/** A live process or loaded thread stands behind it. */
export function isLive(s: Session): boolean {
  const st = s.runtime.state;
  return st === "working" || st === "needs_input" || st === "ready" || st === "idle" || st === "error";
}

/** Something is happening, or someone is waiting: always on the Current map. */
export function isActive(s: Session): boolean {
  return s.runtime.state === "working" || needsYou(s);
}

/** The state wasn't observed directly; say so in the UI. */
export function isInferred(s: Session): boolean {
  return s.runtime.confidence !== "high";
}

export function stateSince(s: Session): string | null {
  return s.runtime.since ?? s.lastActivityAt ?? null;
}

/**
 * Needs You order: blocking errors that need a human first, then explicit waits,
 * then whatever has waited longest.
 */
export function sortNeedsYou(list: Session[], now = Date.now()): Session[] {
  const rank = (s: Session) => (s.runtime.state === "error" ? 0 : 1);
  return [...list].filter(needsYou).sort((a, b) => rank(a) - rank(b) || ageMs(stateSince(b), now) - ageMs(stateSince(a), now) || (a.id < b.id ? -1 : 1));
}

export function countStatuses(sessions: Session[]): Record<StatusKey, number> {
  const out = Object.fromEntries(STATUS_ORDER.map((k) => [k, 0])) as Record<StatusKey, number>;
  for (const s of sessions) out[statusKey(s)]++;
  return out;
}

/** "Waiting for permission" — the reason, or a sensible default for the state. */
export function reasonText(s: Session): string {
  if (s.runtime.reason) return s.runtime.reason;
  return STATUS[statusKey(s)].hint;
}

/** Compact runtime summary for a group: "1 needs you · 2 working". Empty when quiet. */
export function runtimeSummary(counts: Pick<Record<StatusKey, number>, "needs_you" | "working" | "error">): string {
  const parts: string[] = [];
  if (counts.needs_you) parts.push(`${counts.needs_you} needs you`);
  if (counts.error) parts.push(`${counts.error} ${counts.error === 1 ? "error" : "errors"}`);
  if (counts.working) parts.push(`${counts.working} working`);
  return parts.join(" · ");
}

// ───────────── activity events ─────────────

export const EVENT_VERB: Record<ActivityEventType, string> = {
  started_working: "started working",
  needs_input: "needs input",
  became_ready: "finished",
  became_idle: "stopped",
  went_offline: "went offline",
  error: "hit an error",
  resumed: "resumed",
  opened: "opened",
  created: "added",
  status_changed: "changed state",
};

export const EVENT_TONE: Record<ActivityEventType, StatusKey> = {
  started_working: "working",
  needs_input: "needs_you",
  became_ready: "ready",
  became_idle: "idle",
  went_offline: "offline",
  error: "error",
  resumed: "working",
  opened: "idle",
  created: "idle",
  status_changed: "unknown",
};
