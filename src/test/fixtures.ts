import type { RuntimeState, Session } from "../lib/types";

export const NOW = Date.parse("2026-09-24T12:00:00Z");
export const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
export const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

let seq = 0;
export function rt(state: RuntimeState, extra: Partial<Session["runtime"]> = {}): Session["runtime"] {
  return { state, confidence: "high", actionRequired: state === "needs_input", ...extra };
}

export function session(p: Partial<Session> = {}): Session {
  seq++;
  return {
    id: `s${seq}`,
    provider: "codex",
    title: `Session ${seq}`,
    runtime: rt("offline"),
    favorite: false,
    discovery: "scan",
    projectLocked: false,
    titleLocked: false,
    sourceMissing: false,
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    ...p,
  };
}
