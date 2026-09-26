import { describe, expect, it } from "vitest";
import type { Provider } from "../../lib/types";
import { galaxySpacing, layoutSystem, MIN_SEPARATION, sectorWeight, slotPosition, type LayoutInput, type Zone } from "./layout";

const providers: Provider[] = ["claude-code", "claude", "codex"];

function sessions(n: number, seed = "s"): LayoutInput[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${seed}-${i}`,
    provider: providers[i % 3],
    zone: (i === 0 ? 0 : i < n * 0.6 ? 1 : 2) as Zone,
    recency: (i % 7) / 7,
    favorite: false,
    weight: (i % 5) / 5,
  }));
}

const byId = (l: ReturnType<typeof layoutSystem>) => Object.fromEntries(l.placements.map((p) => [p.id, p]));
const radius = (p: { dx: number; dy: number }) => Math.hypot(p.dx, p.dy);

describe("constellation layout", () => {
  it("is deterministic", () => {
    const a = layoutSystem("atlas", sessions(12));
    const b = layoutSystem("atlas", sessions(12).reverse());
    expect(byId(a)).toEqual(byId(b));
  });

  it("different projects get different orientations", () => {
    const a = byId(layoutSystem("atlas", sessions(3)));
    const b = byId(layoutSystem("lumen", sessions(3)));
    expect(a["s-1"].dx).not.toBeCloseTo(b["s-1"].dx);
  });

  it("adding one session barely moves the others (between sector thresholds)", () => {
    // 11 sessions: 4 Claude Code, 4 Claude, 3 Codex. A 5th Claude session keeps every
    // provider's quantized sector weight unchanged.
    const base = sessions(11);
    const before = byId(layoutSystem("website", base));
    const extra: LayoutInput = { ...base[1], id: "new-one" };
    const after = byId(layoutSystem("website", [...base, extra]));
    const moved = base.map((s) => Math.hypot(before[s.id].dx - after[s.id].dx, before[s.id].dy - after[s.id].dy));
    expect(moved.filter((d) => d > 0.5).length).toBeLessThanOrEqual(3);
    expect(Math.max(...moved)).toBeLessThan(MIN_SEPARATION);
  });

  it("puts sessions that need you closest to the core, idle ones at the live zone's edge", () => {
    const live = (id: string, urgency: number): LayoutInput => ({ id, provider: "codex", zone: 0, recency: 0, urgency, favorite: false, weight: 0 });
    const l = byId(layoutSystem("urgency", [live("needs", 0), live("working", 0.45), live("idle", 1)]));
    expect(radius(l.needs)).toBeLessThan(radius(l.working));
    expect(radius(l.working)).toBeLessThan(radius(l.idle));
  });

  it("sector weights only step at powers of two", () => {
    expect([1, 2, 3, 4, 7, 8, 15, 16, 63, 64].map(sectorWeight)).toEqual([1, 2, 2, 3, 3, 4, 4, 5, 6, 7]);
  });

  it("keeps nodes separated with 60+ sessions", () => {
    const l = layoutSystem("dense", sessions(64));
    let tooClose = 0;
    for (let i = 0; i < l.placements.length; i++)
      for (let j = i + 1; j < l.placements.length; j++) {
        const a = l.placements[i];
        const b = l.placements[j];
        if (Math.hypot(a.dx - b.dx, a.dy - b.dy) < MIN_SEPARATION * 0.8) tooClose++;
      }
    expect(tooClose).toBe(0);
  });

  it("zones nest: live inside recent inside older", () => {
    const input = sessions(30);
    const l = byId(layoutSystem("zones", input));
    const rs = (z: Zone) => input.filter((s) => s.zone === z).map((s) => radius(l[s.id]));
    expect(Math.max(...rs(0))).toBeLessThan(Math.min(...rs(1)));
    expect(Math.max(...rs(1))).toBeLessThan(Math.min(...rs(2)));
  });

  it("inside Recent, fresher sessions sit closer to the core", () => {
    const mk = (id: string, recency: number): LayoutInput => ({ id, provider: "codex", zone: 1, recency, favorite: false, weight: 0 });
    const l = byId(layoutSystem("p", [mk("fresh", 0), mk("stale", 1)]));
    expect(radius(l.fresh)).toBeLessThan(radius(l.stale));
  });

  it("older sessions recede", () => {
    const l = layoutSystem("p", sessions(20));
    const older = l.placements.filter((p) => p.zone === 2);
    const live = l.placements.filter((p) => p.zone === 0);
    expect(Math.max(...older.map((p) => p.opacity))).toBeLessThan(Math.min(...live.map((p) => p.opacity)));
  });

  it("sessions of one provider stay angularly clustered", () => {
    const input = sessions(24);
    const l = byId(layoutSystem("sectors", input));
    for (const p of providers) {
      const angles = input.filter((s) => s.provider === p).map((s) => Math.atan2(l[s.id].dy, l[s.id].dx));
      const cx = angles.reduce((a, t) => a + Math.cos(t), 0) / angles.length;
      const cy = angles.reduce((a, t) => a + Math.sin(t), 0) / angles.length;
      expect(Math.hypot(cx, cy)).toBeGreaterThan(0.7);
    }
  });

  it("project slots are stable and well separated at every spacing", () => {
    for (const spacing of [galaxySpacing(0), galaxySpacing(400)]) {
      expect(slotPosition(3, "x", spacing)).toEqual(slotPosition(3, "x", spacing));
      const pts = Array.from({ length: 12 }, (_, i) => slotPosition(i + 1, `p${i}`, spacing));
      let min = Infinity;
      for (let i = 0; i < pts.length; i++)
        for (let j = i + 1; j < pts.length; j++) min = Math.min(min, Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y));
      expect(min).toBeGreaterThan(spacing * 0.6);
    }
  });
});

describe("label placement", () => {
  it("never stacks important labels on top of each other", async () => {
    const { placeLabels } = await import("./labels");
    // Two Needs You nodes almost touching, both preferring the right.
    const req = (id: string, y: number) => ({ id, x: 400, y, r: 6, width: 160, height: 30, preferred: "right" as const, priority: 700, important: true });
    const placed = placeLabels([req("a", 300), req("b", 312)], [], { width: 1200, height: 800 });
    const [a, b] = [placed.get("a")!, placed.get("b")!];
    expect(a && b).toBeTruthy();
    const box = (p: { x: number; y: number; anchor: string }) => ({ x0: p.anchor === "start" ? p.x : p.x - 160, y0: p.y, x1: p.anchor === "start" ? p.x + 160 : p.x, y1: p.y + 30 });
    const A = box(a);
    const B = box(b);
    const overlap = A.x0 < B.x1 && B.x0 < A.x1 && A.y0 < B.y1 && B.y0 < A.y1;
    expect(overlap).toBe(false);
  });
});
