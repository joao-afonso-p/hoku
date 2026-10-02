/**
 * Project Resume, as data: what needs you, where to continue, what changed and what you wrote
 * down. Pure, so the drawer only presents it. Runtime meaning comes from ../runtime/status.
 */
import { ageMs, DURATION } from "../../lib/time";
import type { ActivityEvent, ActivityEventType, Project, Session, SessionLink } from "../../lib/types";
import { isInferred, isLive, reasonText, sortNeedsYou, statusKey } from "../runtime/status";

/** How far back "What changed" looks. */
export const CHANGE_WINDOW_DAYS = 7;
export const MAX_CHANGES = 10;
export const RECENT_COUNT = 5;
export const MAX_NOTES = 4;

/** Event wording for Resume. Ready is a finished *turn*, never a finished task. */
export const RESUME_VERB: Record<ActivityEventType, string> = {
  started_working: "started working",
  needs_input: "asked for input",
  became_ready: "finished its turn",
  became_idle: "went idle",
  went_offline: "went offline",
  error: "hit an error",
  resumed: "resumed after your input",
  opened: "was opened",
  created: "was added",
  status_changed: "changed state",
};

export type ContinueKind = "needs_you" | "working" | "ready" | "error" | "recent";

export interface ContinueWith {
  session: Session;
  kind: ContinueKind;
  /** Why this one, in words that don't overclaim. */
  why: string;
}

export interface ResumeModel {
  /** Every session in the project. */
  sessions: Session[];
  /** Waiting on a human, most urgent first. */
  needs: Session[];
  continueWith: ContinueWith | null;
  /** Most recent sessions that aren't already in `needs`. */
  recent: Session[];
  /** Semantic events from the last CHANGE_WINDOW_DAYS, newest first, capped. */
  changes: ActivityEvent[];
  /** "2 sessions active · 3 turns finished · 1 asked for input". Empty when nothing happened. */
  changeSummary: string;
  /** Sessions with a user note, most recent first. */
  notes: Session[];
  lastActiveAt: string | null;
  /** Linked-session count per session id. */
  linkCount: Map<string, number>;
}

/** Where "New session" starts by default: the project's folder, else where you last worked in it. */
export function launchFolder(project: Project, sessions: Session[]): { path: string; from: "root" | "recent" } | null {
  if (project.rootPath) return { path: project.rootPath, from: "root" };
  const last = sessions
    .filter((s) => s.projectId === project.id && s.workingDirectory && s.source !== "demo")
    .sort((a, b) => ageMs(a.lastActivityAt) - ageMs(b.lastActivityAt))[0];
  return last ? { path: last.workingDirectory!, from: "recent" } : null;
}

/** Can Hoku reopen it? Demo sessions and pruned Claude Code transcripts can't. */
export function canOpen(s: Session): boolean {
  return s.source !== "demo" && !(s.sourceMissing && s.provider === "claude-code");
}

const byRecency = (now: number) => (a: Session, b: Session) => ageMs(a.lastActivityAt, now) - ageMs(b.lastActivityAt, now) || (a.id < b.id ? -1 : 1);

/**
 * Where to pick up: what's waiting on you first, then what's running, then what just finished
 * its turn, then a failed turn, then simply the most recent. Openable sessions win ties.
 */
export function pickContinue(sessions: Session[], now = Date.now()): ContinueWith | null {
  const likely = (s: Session) => (isInferred(s) ? "Likely " : "");
  const openable = sessions.filter(canOpen);
  const pool = openable.length ? openable : sessions;
  const needs = sortNeedsYou(pool, now);
  if (needs[0]) {
    const s = needs[0];
    return { session: s, kind: "needs_you", why: `${isInferred(s) ? "Likely waiting" : "Waiting"} on you: ${reasonText(s).replace(/^./, (c) => c.toLowerCase())}` };
  }
  const recent = [...pool].sort(byRecency(now));
  const working = recent.find((s) => statusKey(s) === "working");
  if (working) return { session: working, kind: "working", why: `${likely(working)}working right now`.replace(/^./, (c) => c.toUpperCase()) };
  const ready = recent.find((s) => statusKey(s) === "ready");
  if (ready) return { session: ready, kind: "ready", why: `${likely(ready)}finished its turn and is ready for your next prompt`.replace(/^./, (c) => c.toUpperCase()) };
  const error = recent.find((s) => statusKey(s) === "error");
  if (error) return { session: error, kind: "error", why: "Its last turn failed" };
  const last = recent.find((s) => s.lastActivityAt);
  if (last) return { session: last, kind: "recent", why: isLive(last) ? "Open, and the most recently active" : "Most recently active" };
  return null;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function summarizeChanges(events: ActivityEvent[]): string {
  const count = (t: ActivityEventType) => events.filter((e) => e.type === t).length;
  const active = new Set(events.filter((e) => e.type === "started_working" || e.type === "resumed" || e.type === "became_ready").map((e) => e.sessionId)).size;
  const parts = [
    active ? plural(active, "session active", "sessions active") : "",
    count("became_ready") ? plural(count("became_ready"), "turn finished", "turns finished") : "",
    count("needs_input") ? `${count("needs_input")} asked for input` : "",
    count("error") ? plural(count("error"), "error", "errors") : "",
  ];
  return parts.filter(Boolean).join(" · ");
}

export function buildResume(projectId: string, data: { sessions: Session[]; activity: ActivityEvent[]; links: SessionLink[] }, now = Date.now()): ResumeModel {
  const sessions = data.sessions.filter((s) => s.projectId === projectId);
  const ids = new Set(sessions.map((s) => s.id));
  const needs = sortNeedsYou(sessions, now);
  const needIds = new Set(needs.map((s) => s.id));
  const sorted = [...sessions].sort(byRecency(now));
  const since = new Date(now - CHANGE_WINDOW_DAYS * DURATION.DAY).toISOString();
  const inWindow = data.activity.filter((e) => ids.has(e.sessionId) && e.timestamp >= since);
  const linkCount = new Map<string, number>();
  for (const l of data.links) {
    if (ids.has(l.fromId)) linkCount.set(l.fromId, (linkCount.get(l.fromId) ?? 0) + 1);
    if (ids.has(l.toId)) linkCount.set(l.toId, (linkCount.get(l.toId) ?? 0) + 1);
  }
  return {
    sessions,
    needs,
    continueWith: pickContinue(sessions, now),
    recent: sorted.filter((s) => !needIds.has(s.id)),
    changes: [...inWindow].sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0)).slice(0, MAX_CHANGES),
    changeSummary: summarizeChanges(inWindow),
    notes: sorted.filter((s) => s.notes?.trim()).slice(0, MAX_NOTES),
    lastActiveAt: sorted.find((s) => s.lastActivityAt)?.lastActivityAt ?? null,
    linkCount,
  };
}

/** "PR #128" from a pull request link, when the provider recorded one. */
export function prLabel(s: Session): string | null {
  const url = s.metadata?.prUrl;
  if (typeof url !== "string") return null;
  const n = /\/pull\/(\d+)\/?$/.exec(url)?.[1];
  return n ? `PR #${n}` : "Pull request";
}
