import { describe, expect, it } from "vitest";
import { daysAgo, minutesAgo, NOW, rt, session } from "../../test/fixtures";
import type { ActivityEvent, ActivityEventType, Project } from "../../lib/types";
import { buildResume, canOpen, CHANGE_WINDOW_DAYS, launchFolder, pickContinue, prLabel, summarizeChanges } from "./model";

const NOW_ISO = new Date(NOW).toISOString();

let n = 0;
const event = (sessionId: string, type: ActivityEventType, timestamp: string): ActivityEvent => ({ id: `e${++n}`, sessionId, type, provider: "codex", timestamp });

describe("pickContinue", () => {
  it("puts what waits on you first, even over newer work", () => {
    const waiting = session({ runtime: rt("needs_input", { reason: "Waiting for approval", since: minutesAgo(30) }), lastActivityAt: minutesAgo(30) });
    const working = session({ runtime: rt("working"), lastActivityAt: minutesAgo(1) });
    const c = pickContinue([working, waiting], NOW)!;
    expect(c.session.id).toBe(waiting.id);
    expect(c.kind).toBe("needs_you");
    expect(c.why).toBe("Waiting on you: waiting for approval");
  });

  it("describes Ready as a finished turn and hedges inferred states", () => {
    const ready = session({ runtime: rt("ready", { confidence: "medium" }), lastActivityAt: minutesAgo(5) });
    const c = pickContinue([ready, session({ lastActivityAt: minutesAgo(2) })], NOW)!;
    expect(c.kind).toBe("ready");
    expect(c.why).toBe("Likely finished its turn and is ready for your next prompt");
    expect(c.why).not.toMatch(/done|complete/i);
  });

  it("prefers working over ready, and falls back to the most recent", () => {
    const ready = session({ runtime: rt("ready"), lastActivityAt: minutesAgo(1) });
    const working = session({ runtime: rt("working"), lastActivityAt: minutesAgo(10) });
    expect(pickContinue([ready, working], NOW)!.session.id).toBe(working.id);
    const old = session({ lastActivityAt: daysAgo(3) });
    const newer = session({ lastActivityAt: daysAgo(1) });
    expect(pickContinue([old, newer], NOW)).toMatchObject({ kind: "recent", why: "Most recently active", session: { id: newer.id } });
    expect(pickContinue([], NOW)).toBeNull();
  });

  it("skips sessions Hoku can't reopen when another one can be", () => {
    const gone = session({ provider: "claude-code", sourceMissing: true, lastActivityAt: minutesAgo(1) });
    const ok = session({ lastActivityAt: daysAgo(2) });
    expect(canOpen(gone)).toBe(false);
    expect(pickContinue([gone, ok], NOW)!.session.id).toBe(ok.id);
    expect(pickContinue([gone], NOW)!.session.id).toBe(gone.id);
  });
});

describe("buildResume", () => {
  it("scopes everything to the project and splits needs from recent", () => {
    const a = session({ projectId: "p", runtime: rt("needs_input"), lastActivityAt: minutesAgo(3), notes: "Decide on the queue" });
    const b = session({ projectId: "p", runtime: rt("ready"), lastActivityAt: minutesAgo(10) });
    const c = session({ projectId: "p", lastActivityAt: daysAgo(20), notes: "   " });
    const other = session({ projectId: "q", runtime: rt("working"), lastActivityAt: minutesAgo(1), notes: "elsewhere" });
    const events = [
      event(b.id, "started_working", minutesAgo(40)),
      event(b.id, "became_ready", minutesAgo(10)),
      event(a.id, "needs_input", minutesAgo(3)),
      event(c.id, "became_ready", daysAgo(CHANGE_WINDOW_DAYS + 1)),
      event(other.id, "became_ready", minutesAgo(1)),
    ];
    const r = buildResume("p", { sessions: [a, b, c, other], activity: events, links: [{ fromId: a.id, toId: b.id, kind: "related", createdAt: "" }] }, NOW);
    expect(r.sessions.map((s) => s.id)).toEqual([a.id, b.id, c.id]);
    expect(r.needs.map((s) => s.id)).toEqual([a.id]);
    expect(r.recent.map((s) => s.id)).toEqual([b.id, c.id]);
    expect(r.changes.map((e) => e.type)).toEqual(["needs_input", "became_ready", "started_working"]);
    expect(r.changeSummary).toBe("1 session active · 1 turn finished · 1 asked for input");
    expect(r.notes.map((s) => s.id)).toEqual([a.id]);
    expect(r.lastActiveAt).toBe(a.lastActivityAt);
    expect(r.linkCount.get(a.id)).toBe(1);
    expect(r.continueWith?.session.id).toBe(a.id);
  });

  it("is empty but well-formed for a project with no sessions", () => {
    const r = buildResume("empty", { sessions: [session({ projectId: "x" })], activity: [], links: [] }, NOW);
    expect(r).toMatchObject({ sessions: [], needs: [], recent: [], changes: [], changeSummary: "", notes: [], lastActiveAt: null, continueWith: null });
  });
});

describe("helpers", () => {
  it("summarizes nothing as empty", () => {
    expect(summarizeChanges([])).toBe("");
  });

  it("labels pull requests without exposing the link", () => {
    expect(prLabel(session({ metadata: { prUrl: "https://github.com/o/r/pull/42" } }))).toBe("PR #42");
    expect(prLabel(session({ metadata: { prUrl: "https://example.test/review" } }))).toBe("Pull request");
    expect(prLabel(session())).toBeNull();
  });
});

describe("launchFolder", () => {
  const atlas: Project = { id: "p1", name: "Atlas", rootPath: null, slot: 1, isDemo: false, createdAt: NOW_ISO, updatedAt: NOW_ISO };

  it("starts in the project's folder", () => {
    expect(launchFolder({ ...atlas, rootPath: "/work/atlas" }, [session({ projectId: "p1", workingDirectory: "/tmp/x" })])).toEqual({ path: "/work/atlas", from: "root" });
  });

  it("without one, starts where you last worked in the project", () => {
    const sessions = [
      session({ projectId: "p1", workingDirectory: "/work/old", lastActivityAt: daysAgo(3) }),
      session({ projectId: "p1", workingDirectory: "/work/new", lastActivityAt: minutesAgo(5) }),
      session({ projectId: "p2", workingDirectory: "/work/elsewhere", lastActivityAt: minutesAgo(1) }),
      session({ projectId: "p1", workingDirectory: "/demo", source: "demo", lastActivityAt: minutesAgo(1) }),
    ];
    expect(launchFolder(atlas, sessions)).toEqual({ path: "/work/new", from: "recent" });
  });

  it("has nothing to offer for an empty project with no folder", () => {
    expect(launchFolder(atlas, [session({ projectId: "p1" })])).toBeNull();
  });
});
