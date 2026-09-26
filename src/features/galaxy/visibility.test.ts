import { describe, expect, it } from "vitest";
import type { RuntimeState, Session } from "../../lib/types";
import { countVisibility, DEFAULT_VISIBILITY, isSessionVisible, visibilityFromSettings, visibilityReason } from "./visibility";

const NOW = Date.parse("2026-09-24T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

function rt(state: RuntimeState, actionRequired = state === "needs_input"): Session["runtime"] {
  return { state, confidence: "high", actionRequired };
}

function session(p: Partial<Session>): Session {
  return {
    id: Math.random().toString(36),
    provider: "codex",
    title: "t",
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

const current = DEFAULT_VISIBILITY;

describe("galaxy visibility", () => {
  it("defaults to Current · 7 days · active and favorites always shown", () => {
    expect(visibilityFromSettings({})).toEqual({ mode: "current", recentWindowDays: 7, alwaysShowActive: true, alwaysShowFavorites: true, hideInactive: false });
  });

  it("shows recent, hides old inactive non-favorites", () => {
    expect(isSessionVisible(session({ lastActivityAt: daysAgo(2) }), current, NOW)).toBe(true);
    expect(isSessionVisible(session({ lastActivityAt: daysAgo(40) }), current, NOW)).toBe(false);
  });

  it("always shows live sessions, even old ones", () => {
    for (const state of ["working", "needs_input", "ready", "idle", "error"] as const) {
      expect(visibilityReason(session({ lastActivityAt: daysAgo(90), runtime: rt(state) }), current, NOW)).toBe("live");
    }
  });

  it("keeps runtime state and recency separate", () => {
    // Offline but recent: on the map for recency, not liveness. Unknown and old: hidden.
    expect(visibilityReason(session({ lastActivityAt: daysAgo(1), runtime: rt("offline") }), current, NOW)).toBe("recent");
    expect(isSessionVisible(session({ lastActivityAt: daysAgo(90), runtime: rt("unknown") }), current, NOW)).toBe(false);
  });

  it("always shows favorites, but doesn't call them recent", () => {
    const s = session({ lastActivityAt: daysAgo(90), favorite: true });
    expect(visibilityReason(s, current, NOW)).toBe("favorite");
  });

  it("respects the configured window", () => {
    const s = session({ lastActivityAt: daysAgo(10) });
    expect(isSessionVisible(s, { ...current, recentWindowDays: 7 }, NOW)).toBe(false);
    expect(isSessionVisible(s, { ...current, recentWindowDays: 14 }, NOW)).toBe(true);
    expect(isSessionVisible(s, { ...current, recentWindowDays: 3 }, NOW)).toBe(false);
  });

  it("All shows everything, marking old sessions as archive", () => {
    const s = session({ lastActivityAt: daysAgo(200) });
    expect(visibilityReason(s, { ...current, mode: "all" }, NOW)).toBe("archive");
  });

  it("never treats an import time as recency for discovered sessions", () => {
    // Discovered with no provider timestamp: createdAt is our import time, so it isn't recent.
    expect(isSessionVisible(session({ lastActivityAt: null }), current, NOW)).toBe(false);
    // Manual sessions fall back to when you added them.
    expect(isSessionVisible(session({ lastActivityAt: null, discovery: "manual" }), current, NOW)).toBe(true);
  });

  it("toggles can turn off the always-show rules", () => {
    const fav = session({ lastActivityAt: daysAgo(90), favorite: true });
    expect(isSessionVisible(fav, { ...current, alwaysShowFavorites: false }, NOW)).toBe(false);
    const idle = session({ lastActivityAt: daysAgo(90), runtime: rt("idle") });
    expect(isSessionVisible(idle, { ...current, alwaysShowActive: false }, NOW)).toBe(false);
  });

  it("never hides a session that needs you", () => {
    const waiting = session({ lastActivityAt: daysAgo(90), runtime: rt("needs_input") });
    expect(isSessionVisible(waiting, { ...current, alwaysShowActive: false }, NOW)).toBe(true);
  });

  it("counts visible vs total", () => {
    const list = [session({ lastActivityAt: daysAgo(1) }), session({ lastActivityAt: daysAgo(60) }), session({ lastActivityAt: daysAgo(60), runtime: rt("idle") })];
    expect(countVisibility(list, current, NOW)).toEqual({ visible: 2, total: 3, live: 1, older: 1 });
  });
});
