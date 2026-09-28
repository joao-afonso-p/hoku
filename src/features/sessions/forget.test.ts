import { describe, expect, it } from "vitest";
import type { Project } from "../../lib/types";
import { session } from "../../test/fixtures";
import { forgetPlan, NEXT_STEP_MAX, nextStepLength } from "./forget";

const project = (p: Partial<Project> = {}): Project => ({
  id: "p1",
  name: "Atlas",
  slot: 0,
  isDemo: false,
  createdAt: "2026-09-24T12:00:00Z",
  updatedAt: "2026-09-24T12:00:00Z",
  ...p,
});

describe("forgetPlan", () => {
  it("warns that a scanned session still at its source comes back", () => {
    expect(forgetPlan(session({ discovery: "scan" }), undefined).mayReturn).toBe(true);
    expect(forgetPlan(session({ discovery: "scan", sourceMissing: true }), undefined).mayReturn).toBe(false);
    expect(forgetPlan(session({ discovery: "manual" }), undefined).mayReturn).toBe(false);
  });

  it("keeps the note by default only when there's no next step to replace", () => {
    const s = session({ projectId: "p1", notes: "  Ship the migration  " });
    expect(forgetPlan(s, project())).toMatchObject({ canKeep: true, note: "Ship the migration", replaces: null, keepByDefault: true });
    expect(forgetPlan(s, project({ nextStep: "Review the PR" }))).toMatchObject({ canKeep: true, replaces: "Review the PR", keepByDefault: false });
  });

  it("uses the inspector's unsaved text over the stored note", () => {
    const s = session({ projectId: "p1", notes: "old" });
    expect(forgetPlan(s, project(), "new").note).toBe("new");
    expect(forgetPlan(s, project(), "  ").canKeep).toBe(false);
  });

  it("offers nothing to keep without a note or a real project", () => {
    expect(forgetPlan(session({ projectId: "p1" }), project()).canKeep).toBe(false);
    expect(forgetPlan(session({ notes: "n" }), undefined).canKeep).toBe(false);
    expect(forgetPlan(session({ projectId: "p2", notes: "n" }), project()).canKeep).toBe(false);
    expect(forgetPlan(session({ projectId: "p1", notes: "n" }), project({ isDemo: true })).canKeep).toBe(false);
    expect(forgetPlan(session({ projectId: "p1", notes: "n", source: "demo" }), project()).canKeep).toBe(false);
  });
});

describe("nextStepLength", () => {
  it("counts characters the way the backend limit does", () => {
    expect(nextStepLength("  abc  ")).toBe(3);
    expect(nextStepLength("🚀".repeat(NEXT_STEP_MAX))).toBe(NEXT_STEP_MAX);
    expect(nextStepLength("x".repeat(NEXT_STEP_MAX + 1))).toBeGreaterThan(NEXT_STEP_MAX);
  });
});
