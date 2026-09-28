/**
 * Follow up semantics for the UI: when an item is due, how it's labelled, ordered and grouped,
 * and the snooze presets. The backend only stores `addedAt` / `dueAt` (src-tauri/src/db.rs).
 *
 * Follow up ≠ Needs You: Needs You is a live provider block (runtime/status.ts); Follow up is
 * the user's own "review later" list. Nothing lands here unless the user puts it here.
 */
import { ageMs, DURATION } from "../../lib/time";
import type { FollowUp, Session } from "../../lib/types";

/** overdue: the reminder passed on an earlier day · due: it passed today · scheduled: later · open: no date. */
export type FollowUpKey = "overdue" | "due" | "scheduled" | "open";
export type FollowUpSection = "due" | "open" | "scheduled";
export type FollowUpGrouping = "date" | "project";

export const OVERDUE = "#e0907f";

export const SECTION_LABEL: Record<FollowUpSection, string> = {
  due: "Due",
  open: "No date",
  scheduled: "Scheduled",
};
const SECTION_ORDER: Record<FollowUpSection, number> = { due: 0, open: 1, scheduled: 2 };

export function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function time(iso: string | null | undefined): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? NaN : t;
}

export function followUpKey(f: FollowUp, now = Date.now()): FollowUpKey {
  const due = time(f.dueAt);
  if (Number.isNaN(due)) return "open";
  if (due > now) return "scheduled";
  return due < startOfDay(now) ? "overdue" : "due";
}

export function sectionOf(key: FollowUpKey): FollowUpSection {
  return key === "overdue" || key === "due" ? "due" : key;
}

export function isDue(f: FollowUp | null | undefined, now = Date.now()): boolean {
  return !!f && sectionOf(followUpKey(f, now)) === "due";
}

export type Queued = Session & { followUp: FollowUp };

export function queued(sessions: Session[]): Queued[] {
  return sessions.filter((s): s is Queued => !!s.followUp);
}

/** Reminders that have gone off: the rail badge. */
export function dueCount(sessions: Session[], now = Date.now()): number {
  return sessions.filter((s) => isDue(s.followUp, now)).length;
}

/**
 * Due first (the longest overdue on top), then undated in the order they were added,
 * then scheduled, soonest first.
 */
export function sortFollowUps(list: Queued[], now = Date.now()): Queued[] {
  const rank = (s: Queued) => SECTION_ORDER[sectionOf(followUpKey(s.followUp, now))];
  const within = (a: Queued, b: Queued) => {
    const section = sectionOf(followUpKey(a.followUp, now));
    if (section === "open") return time(a.followUp.addedAt) - time(b.followUp.addedAt);
    return time(a.followUp.dueAt) - time(b.followUp.dueAt);
  };
  return [...list].sort((a, b) => rank(a) - rank(b) || within(a, b) || (a.id < b.id ? -1 : 1));
}

export interface FollowUpGroup {
  key: string;
  label: string;
  items: Queued[];
}

/**
 * By date: Due · No date · Scheduled. By project: one group per project, the one with the
 * most urgent item first. Items keep the queue order inside each group.
 */
export function groupFollowUps(list: Queued[], by: FollowUpGrouping, projectOf: (s: Session) => { key: string; label: string }, now = Date.now()): FollowUpGroup[] {
  const sorted = sortFollowUps(list, now);
  const groups = new Map<string, FollowUpGroup>();
  for (const s of sorted) {
    const g = by === "date" ? { key: sectionOf(followUpKey(s.followUp, now)), label: "" } : projectOf(s);
    if (!groups.has(g.key)) groups.set(g.key, { key: g.key, label: by === "date" ? SECTION_LABEL[g.key as FollowUpSection] : g.label, items: [] });
    groups.get(g.key)!.items.push(s);
  }
  const out = [...groups.values()];
  if (by === "date") out.sort((a, b) => SECTION_ORDER[a.key as FollowUpSection] - SECTION_ORDER[b.key as FollowUpSection]);
  return out;
}

// ───────────── labels ─────────────

const pad = (n: number) => String(n).padStart(2, "0");

export function clockTime(t: number): string {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "Today", "Tomorrow", "Mon", "Oct 12": how far away a day is, relative to now. */
export function dayName(t: number, now = Date.now()): string {
  const days = Math.round((startOfDay(t) - startOfDay(now)) / DURATION.DAY);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days === -1) return "Yesterday";
  if (days > 1 && days < 7) return new Date(t).toLocaleDateString(undefined, { weekday: "short" });
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "4m", "2h", "3d". */
function span(ms: number): string {
  if (ms < DURATION.HOUR) return `${Math.max(1, Math.floor(ms / DURATION.MIN))}m`;
  if (ms < DURATION.DAY) return `${Math.floor(ms / DURATION.HOUR)}h`;
  return `${Math.floor(ms / DURATION.DAY)}d`;
}

/** "Overdue · 2d", "Due 14:00", "Tomorrow 09:00", "No date". */
export function dueLabel(f: FollowUp, now = Date.now()): string {
  const key = followUpKey(f, now);
  if (key === "open") return "No date";
  const due = time(f.dueAt);
  if (key === "overdue") return `Overdue · ${span(now - due)}`;
  if (key === "due") return now - due < DURATION.MIN ? "Due now" : `Due ${clockTime(due)}`;
  return `${dayName(due, now)} ${clockTime(due)}`;
}

/** How long it has been in the queue: "added 2h ago". */
export function addedLabel(f: FollowUp, now = Date.now()): string {
  const a = ageMs(f.addedAt, now);
  if (!Number.isFinite(a)) return "";
  return a < DURATION.MIN ? "added just now" : `added ${span(a)} ago`;
}

/** The session was opened after it was queued: a hint that it may be done. */
export function openedSince(s: Queued): boolean {
  return !!s.lastOpenedAt && time(s.lastOpenedAt) > time(s.followUp.addedAt);
}

// ───────────── snooze ─────────────

export interface SnoozePreset {
  id: "later" | "tomorrow" | "next-week";
  label: string;
  at: number;
}

const MORNING = 9;

/** In 3 hours (on the next quarter hour), tomorrow at 9, next Monday at 9. */
export function snoozePresets(now = Date.now()): SnoozePreset[] {
  const quarter = 15 * DURATION.MIN;
  const later = Math.ceil((now + 3 * DURATION.HOUR) / quarter) * quarter;
  const tomorrow = new Date(startOfDay(now));
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(MORNING);
  const monday = new Date(startOfDay(now));
  monday.setDate(monday.getDate() + (((8 - monday.getDay()) % 7) || 7));
  monday.setHours(MORNING);
  return [
    { id: "later", label: "In 3 hours", at: later },
    { id: "tomorrow", label: "Tomorrow", at: tomorrow.getTime() },
    { id: "next-week", label: "Next week", at: monday.getTime() },
  ];
}

/** `<input type="datetime-local">` speaks local wall time without a zone. */
export function toLocalInput(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number);
  const t = new Date(y, mo - 1, d, h, mi).getTime();
  return Number.isNaN(t) ? null : t;
}
