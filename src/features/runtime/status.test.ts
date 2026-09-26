import { describe, expect, it } from "vitest";
import { minutesAgo, NOW, rt, session } from "../../test/fixtures";
import { countStatuses, isActive, needsYou, runtimeSummary, sortNeedsYou, statusKey } from "./status";

describe("runtime status semantics", () => {
  it("Ready is never Needs You", () => {
    const done = session({ runtime: rt("ready") });
    expect(needsYou(done)).toBe(false);
    expect(statusKey(done)).toBe("ready");
    expect(sortNeedsYou([done])).toEqual([]);
  });

  it("needs_input and action-required errors are Needs You; other errors aren't", () => {
    expect(needsYou(session({ runtime: rt("needs_input") }))).toBe(true);
    expect(statusKey(session({ runtime: rt("error", { actionRequired: true }) }))).toBe("needs_you");
    expect(statusKey(session({ runtime: rt("error") }))).toBe("error");
  });

  it("sorts the inbox: blocking errors, then the longest wait first", () => {
    const recent = session({ runtime: rt("needs_input", { since: minutesAgo(2) }) });
    const old = session({ runtime: rt("needs_input", { since: minutesAgo(40) }) });
    const auth = session({ runtime: rt("error", { actionRequired: true, since: minutesAgo(1) }) });
    const working = session({ runtime: rt("working") });
    expect(sortNeedsYou([recent, working, old, auth], NOW).map((s) => s.id)).toEqual([auth.id, old.id, recent.id]);
  });

  it("counts partition every session exactly once", () => {
    const list = [rt("needs_input"), rt("error", { actionRequired: true }), rt("error"), rt("working"), rt("ready"), rt("idle"), rt("offline"), rt("unknown")].map((r) =>
      session({ runtime: r }),
    );
    const c = countStatuses(list);
    expect(c).toEqual({ needs_you: 2, error: 1, working: 1, ready: 1, idle: 1, offline: 1, unknown: 1 });
    expect(Object.values(c).reduce((a, b) => a + b, 0)).toBe(list.length);
  });

  it("active = working or needs you, for Current visibility and search", () => {
    expect(isActive(session({ runtime: rt("working") }))).toBe(true);
    expect(isActive(session({ runtime: rt("ready") }))).toBe(false);
  });

  it("summarises quietly", () => {
    expect(runtimeSummary({ needs_you: 1, error: 0, working: 2 })).toBe("1 needs you · 2 working");
    expect(runtimeSummary({ needs_you: 0, error: 0, working: 0 })).toBe("");
  });
});
