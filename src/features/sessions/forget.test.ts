import { describe, expect, it } from "vitest";
import type { Project } from "../../lib/types";
import { session } from "../../test/fixtures";
import { forgetMessage, forgetPlan, NEXT_STEP_MAX, nextStepLength } from "./forget";

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
  it("marks scanned sessions, whether or not the provider still has them", () => {
    expect(forgetPlan(session({ discovery: "scan" }), undefined).scanned).toBe(true);
    expect(forgetPlan(session({ discovery: "scan", sourceMissing: true }), undefined).scanned).toBe(true);
    expect(forgetPlan(session({ discovery: "manual" }), undefined).scanned).toBe(false);
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

describe("forgetMessage", () => {
  it("says an unchanged scan leaves a forgotten session out, and only new activity brings it back", () => {
    const scanned = forgetMessage(forgetPlan(session({ discovery: "scan" }), undefined), "Codex");
    expect(scanned).toContain("Codex’s copy isn’t touched");
    expect(scanned).toContain("Scans leave it out until it has new activity in Codex");
    expect(scanned).not.toMatch(/next scan adds it back/);
  });

  it("doesn't mention scans for sessions added by hand", () => {
    const manual = forgetMessage(forgetPlan(session({ discovery: "manual" }), undefined), "Claude");
    expect(manual).toBe("Removes it from Hoku, with its note, links and activity. Claude’s copy isn’t touched.");
  });
});
