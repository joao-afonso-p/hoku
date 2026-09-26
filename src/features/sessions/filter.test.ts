import { describe, expect, it } from "vitest";
import { daysAgo, NOW, rt, session } from "../../test/fixtures";
import { applyFilter, isFilterEmpty, matchesFilter, type FilterContext } from "./filter";

const ctx: FilterContext = { now: NOW, projectNames: new Map([["p-lumen", "Lumen"], ["p-atlas", "Atlas"]]) };

describe("session filter", () => {
  const a = session({ title: "Evaluation pipeline", projectId: "p-lumen", provider: "claude-code", runtime: rt("needs_input"), lastActivityAt: daysAgo(0.1) });
  const b = session({ title: "Calendar integration", projectId: "p-atlas", provider: "codex", runtime: rt("working"), lastActivityAt: daysAgo(0.2), favorite: true });
  const c = session({ title: "Mobile redesign", projectId: null, provider: "claude", runtime: rt("ready"), lastActivityAt: daysAgo(20), providerAccountId: "acc-2" });
  const d = session({ title: "Old thing", projectId: "gone", provider: "codex", runtime: rt("offline"), lastActivityAt: daysAgo(90) });
  const all = [a, b, c, d];
  const ids = (list: { id: string }[]) => list.map((s) => s.id);

  it("empty filter keeps everything", () => {
    expect(isFilterEmpty({})).toBe(true);
    expect(applyFilter(all, {}, ctx)).toBe(all);
  });

  it("multi-select status is OR within the facet", () => {
    expect(ids(applyFilter(all, { statuses: ["needs_you", "working"] }, ctx))).toEqual([a.id, b.id]);
  });

  it("facets combine with AND", () => {
    expect(ids(applyFilter(all, { statuses: ["needs_you", "working"], providers: ["codex"] }, ctx))).toEqual([b.id]);
    expect(ids(applyFilter(all, { favoritesOnly: true, statuses: ["working"] }, ctx))).toEqual([b.id]);
  });

  it("unknown project ids count as Unsorted", () => {
    expect(ids(applyFilter(all, { projects: ["unsorted"] }, ctx))).toEqual([c.id, d.id]);
  });

  it("filters by recency, account and text", () => {
    expect(ids(applyFilter(all, { recentWindowDays: 7 }, ctx))).toEqual([a.id, b.id]);
    expect(ids(applyFilter(all, { accounts: ["acc-2"] }, ctx))).toEqual([c.id]);
    expect(matchesFilter(a, { query: "lumen eval" }, ctx)).toBe(true);
    expect(matchesFilter(a, { query: "lumen calendar" }, ctx)).toBe(false);
  });
});
