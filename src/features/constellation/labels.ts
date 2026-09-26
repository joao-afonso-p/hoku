/**
 * Greedy, priority-ordered label placement in screen space. Deterministic for a given
 * frame: labels that would collide with a higher-priority label or a node are hidden
 * (they reappear on hover), rather than overlapping.
 */

export interface LabelRequest {
  id: string;
  x: number;
  y: number;
  /** Radius of the node the label belongs to. */
  r: number;
  width: number;
  height: number;
  preferred: "left" | "right";
  priority: number;
  /** Always place, even if it collides (hovered / selected). */
  force?: boolean;
  /**
   * Must be shown (Needs You, errors): searches many more positions, and may sit over a node,
   * but never on top of another label. Only if every position is taken does it fall back to
   * its preferred spot.
   */
  important?: boolean;
}

export interface Obstacle {
  x: number;
  y: number;
  r: number;
}

export interface PlacedLabel {
  x: number;
  y: number;
  anchor: "start" | "end";
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const GAP = 7;

function boxFor(req: LabelRequest, side: "left" | "right", dy: number): { box: Box; placed: PlacedLabel } {
  const top = req.y - req.height / 2 + dy;
  if (side === "right") {
    const x = req.x + req.r + GAP;
    return { box: { x0: x - 2, y0: top, x1: x + req.width + 2, y1: top + req.height }, placed: { x, y: top, anchor: "start" } };
  }
  const x = req.x - req.r - GAP;
  return { box: { x0: x - req.width - 2, y0: top, x1: x + 2, y1: top + req.height }, placed: { x, y: top, anchor: "end" } };
}

const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

function hitsCircle(b: Box, c: Obstacle) {
  const cx = Math.max(b.x0, Math.min(c.x, b.x1));
  const cy = Math.max(b.y0, Math.min(c.y, b.y1));
  return (cx - c.x) ** 2 + (cy - c.y) ** 2 < c.r * c.r;
}

export function placeLabels(
  requests: LabelRequest[],
  obstacles: (Obstacle & { id?: string })[],
  bounds: { left?: number; top?: number; width: number; height: number },
  fixed: Box[] = [],
): Map<string, PlacedLabel> {
  const out = new Map<string, PlacedLabel>();
  const taken: Box[] = [...fixed];
  const sorted = [...requests].sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : 1));

  for (const req of sorted) {
    const other = req.preferred === "right" ? "left" : "right";
    const attempts: ["left" | "right", number][] = [
      [req.preferred, 0],
      [req.preferred, -req.height * 0.55],
      [req.preferred, req.height * 0.55],
      [other, 0],
    ];
    const fits = (c: { box: Box }, avoidNodes: boolean) => {
      const inBounds = c.box.x0 > (bounds.left ?? 0) + 4 && c.box.x1 < bounds.width - 4 && c.box.y0 > (bounds.top ?? 0) + 4 && c.box.y1 < bounds.height - 4;
      if (!inBounds || taken.some((t) => overlaps(t, c.box))) return false;
      return !avoidNodes || !obstacles.some((o) => o.id !== req.id && hitsCircle(c.box, o));
    };
    let chosen: { box: Box; placed: PlacedLabel } | null = null;
    for (const [side, dy] of attempts) {
      const c = boxFor(req, side, dy);
      if (fits(c, true)) {
        chosen = c;
        break;
      }
    }
    if (!chosen && req.important) {
      // Wider search: step up and down on both sides, first clear of nodes, then over them.
      const steps = [1.1, -1.1, 1.65, -1.65, 2.2, -2.2, 2.75, -2.75].map((k) => k * req.height);
      const wide: ["left" | "right", number][] = [...[other, req.preferred].flatMap((side) => [-0.55, 0.55].map((k) => [side, k * req.height] as ["left" | "right", number])), ...steps.flatMap((dy) => [[req.preferred, dy], [other, dy]] as ["left" | "right", number][])];
      for (const avoidNodes of [true, false]) {
        for (const [side, dy] of wide) {
          const c = boxFor(req, side, dy);
          if (fits(c, avoidNodes)) {
            chosen = c;
            break;
          }
        }
        if (chosen) break;
      }
    }
    if (!chosen && (req.force || req.important)) chosen = boxFor(req, req.preferred, 0);
    if (chosen) {
      taken.push(chosen.box);
      out.set(req.id, chosen.placed);
    }
  }
  return out;
}

// ───── text measurement ─────

let ctx: CanvasRenderingContext2D | null = null;
const cache = new Map<string, number>();

export function measure(text: string, font: string): number {
  const key = font + "|" + text;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  ctx ??= document.createElement("canvas").getContext("2d");
  if (!ctx) return text.length * 6.5;
  ctx.font = font;
  const w = ctx.measureText(text).width;
  if (cache.size > 4000) cache.clear();
  cache.set(key, w);
  return w;
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1).trimEnd() + "…";
}
