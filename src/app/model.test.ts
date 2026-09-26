import { describe, expect, it } from "vitest";
import { DEFAULT_VISIBILITY } from "../features/galaxy/visibility";
import type { HubSnapshot, Project } from "../lib/types";
import { minutesAgo, NOW, rt, session } from "../test/fixtures";
import { buildSystems, mapKey, UNSORTED, visibleSystems } from "./model";

function project(id: string, slot: number, archivedAt: string | null = null): Project {
  return { id, name: id, slot, isDemo: false, archivedAt, createdAt: "", updatedAt: "" };
}

function snapshot(projects: Project[], sessions: ReturnType<typeof session>[]): HubSnapshot {
  return { projects, sessions, accounts: [], links: [], lastScans: [], settings: {}, activity: [] };
}

describe("inactive projects", () => {
  const busy = project("busy", 1);
  const quiet = project("quiet", 2);
  const later = project("later", 3);
  const data = snapshot([busy, quiet, later], [session({ projectId: "busy", lastActivityAt: minutesAgo(1) }), session({ projectId: "later", lastActivityAt: minutesAgo(1) }), session({ projectId: "quiet", lastActivityAt: "2020-01-01T00:00:00Z" })]);

  it("stay on the map by default", () => {
    const systems = buildSystems(data, NOW, DEFAULT_VISIBILITY, null);
    expect(visibleSystems(systems, DEFAULT_VISIBILITY, []).map((s) => s.key)).toEqual(["busy", "quiet", "later"]);
  });

  it("can be hidden without moving the others", () => {
    const v = { ...DEFAULT_VISIBILITY, hideInactive: true };
    const systems = buildSystems(data, NOW, v, null);
    const shown = visibleSystems(systems, v, []);
    expect(shown.map((s) => s.key)).toEqual(["busy", "later"]);
    expect(shown.find((s) => s.key === "later")).toBe(systems.find((s) => s.key === "later"));
    // The project you're looking at never vanishes under you.
    expect(visibleSystems(systems, v, ["quiet"]).map((s) => s.key)).toContain("quiet");
    // All always shows everything.
    expect(visibleSystems(systems, { ...v, mode: "all" }, []).length).toBe(3);
  });
});

describe("archived projects", () => {
  const lumen = project("lumen", 1);
  const old = project("old", 2, minutesAgo(5));
  const a = session({ projectId: "lumen", lastActivityAt: minutesAgo(3) });
  const b = session({ projectId: "old", lastActivityAt: minutesAgo(3), runtime: rt("needs_input") });
  const loose = session({ projectId: null, lastActivityAt: minutesAgo(3) });

  it("leave the Galaxy without spilling their sessions into Unsorted", () => {
    const systems = buildSystems(snapshot([lumen, old], [a, b, loose]), NOW, DEFAULT_VISIBILITY, null);
    expect(systems.map((s) => s.key)).toEqual(["lumen", UNSORTED]);
    expect(systems.find((s) => s.key === UNSORTED)!.sessions.map((s) => s.id)).toEqual([loose.id]);
  });

  it("keep other projects in place", () => {
    const withArchived = buildSystems(snapshot([lumen, old], [a]), NOW, DEFAULT_VISIBILITY, null);
    const withoutArchived = buildSystems(snapshot([lumen], [a]), NOW, DEFAULT_VISIBILITY, null);
    const pos = (list: typeof withArchived) => list.find((s) => s.key === "lumen")!;
    expect([pos(withArchived).x, pos(withArchived).y]).toEqual([pos(withoutArchived).x, pos(withoutArchived).y]);
  });

  it("have no map position, but their sessions keep their project", () => {
    expect(mapKey(b, [lumen, old])).toBeNull();
    expect(b.projectId).toBe("old");
    expect(mapKey(loose, [lumen, old])).toBe(UNSORTED);
    expect(mapKey(a, [lumen, old])).toBe("lumen");
  });
});
