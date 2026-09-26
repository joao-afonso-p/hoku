/**
 * Deterministic constellation layout. See docs/constellation-layout.md.
 *
 * Distance from the core encodes relevance in three zones — Live, Recent, Older — and angle
 * encodes provider. Inside the Live zone, runtime state sets the radius: Needs You sits
 * closest to the core, then errors, working, ready, idle. Positions are a pure function of (ids, provider set, zone, recency):
 * no randomness, no simulation, so a session lives in the same place across launches.
 */
import { unit } from "../../lib/hash";
import type { Provider } from "../../lib/types";
import { PROVIDERS } from "../../providers";

/** 0 = live (running/open), 1 = recent (inside the window), 2 = older (archive / old favorite). */
export type Zone = 0 | 1 | 2;

export interface LayoutInput {
  id: string;
  provider: Provider;
  zone: Zone;
  /** Inside the Recent zone: 0 = just now … 1 = at the edge of the recent window. */
  recency: number;
  /** Inside the Live zone: 0 = most urgent (needs you) … 1 = least (idle). */
  urgency?: number;
  favorite: boolean;
  /** 0..1 interaction weight (e.g. number of turns). */
  weight: number;
}

export interface Placement {
  id: string;
  /** Offset from the project core, in focus units. */
  dx: number;
  dy: number;
  zone: Zone;
  /** Node radius in px (screen space) at Project Focus scale. */
  size: number;
  /** 0..1 — older sessions recede. */
  opacity: number;
}

export interface SystemLayout {
  placements: Placement[];
  /** Radius (focus units) that encloses every node. */
  extent: number;
  /** Zones actually used, with their representative radius, for faint guides. */
  zones: { zone: Zone; radius: number }[];
  /** Angular sector per provider present, in radians. */
  sectors: { provider: Provider; start: number; end: number }[];
}

/** Zone geometry in focus units, before density scaling: [inner, outer]. */
export const ZONES: Record<Zone, [number, number]> = {
  0: [94, 152],
  1: [178, 292],
  2: [352, 426],
};
export const MIN_SEPARATION = 36;

/** How much a system is scaled down in Galaxy View relative to Project Focus. */
export const GALAXY_SCALE = 0.56;

/** Quantized so that the whole system only re-scales at a few thresholds. */
export function densityScale(n: number): number {
  if (n <= 16) return 1;
  if (n <= 32) return 1.2;
  if (n <= 56) return 1.42;
  return 1.7;
}

/** 1 → 1, 2–3 → 2, 4–7 → 3, 8–15 → 4, … */
export function sectorWeight(n: number): number {
  return n <= 0 ? 0 : Math.floor(Math.log2(n)) + 1;
}

export function nodeSize(s: Pick<LayoutInput, "weight" | "favorite" | "zone">): number {
  const w = Math.max(0, Math.min(1, s.weight));
  const base = 4.4 + w * 2.8 + (s.favorite ? 0.6 : 0);
  return s.zone === 0 ? base + 1 : s.zone === 2 ? base * 0.8 : base;
}

function opacityFor(s: LayoutInput): number {
  if (s.zone === 0) return 1;
  if (s.zone === 1) return 1 - 0.28 * Math.max(0, Math.min(1, s.recency));
  // Older: background. Old favorites stay a little more present, but never "recent".
  return s.favorite ? 0.62 : 0.36;
}

function normalizeAngle(a: number): number {
  const t = Math.PI * 2;
  return ((a % t) + t) % t;
}

interface Working {
  id: string;
  x: number;
  y: number;
  zone: Zone;
  rMin: number;
  rMax: number;
  aMin: number;
  aMax: number;
  size: number;
  opacity: number;
}

export function layoutSystem(projectKey: string, sessions: LayoutInput[]): SystemLayout {
  const present = [...new Set(sessions.map((s) => s.provider))].sort((a, b) => PROVIDERS[a].order - PROVIDERS[b].order);

  // Sector widths grow with a quantized log of the provider's session count, so a busy
  // provider gets more room but boundaries only move at 1/2/4/8/16/32… sessions.
  const counts = new Map<Provider, number>();
  for (const s of sessions) counts.set(s.provider, (counts.get(s.provider) ?? 0) + 1);
  const weights = present.map((p) => sectorWeight(counts.get(p) ?? 0));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const starts: number[] = [];
  let acc = 0;
  for (const w of weights) {
    starts.push(acc);
    acc += (w / total) * Math.PI * 2;
  }
  const widthOf = (i: number) => (weights[i] / total) * Math.PI * 2;
  const rotation = unit(projectKey, "rotation") * Math.PI * 2;
  const scale = densityScale(sessions.length);

  // Stable processing order: by id, never by recency or insertion time.
  const ordered = [...sessions].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const nodes: Working[] = ordered.map((s) => {
    const sector = present.indexOf(s.provider);
    const width = widthOf(sector);
    // Soft boundaries: sectors overlap slightly so it reads as a constellation, not a pie.
    const pad = Math.min(0.08 * width, 0.18);
    const aMin = rotation + starts[sector] + pad;
    const aMax = rotation + starts[sector] + width - pad;
    const angle = aMin + unit(s.id, "angle") * (aMax - aMin);
    const [z0, z1] = ZONES[s.zone];
    const inner = z0 * scale;
    const outer = z1 * scale;
    const jitter = (unit(s.id, "radius") - 0.5) * 0.18 * (outer - inner);
    const t = s.zone === 1 ? Math.max(0, Math.min(1, s.recency)) : s.zone === 0 ? Math.max(0, Math.min(1, s.urgency ?? 0.5)) : 0.5;
    const r = inner + t * (outer - inner) + jitter;
    return {
      id: s.id,
      x: Math.cos(angle) * r,
      y: Math.sin(angle) * r,
      zone: s.zone,
      rMin: inner,
      rMax: outer + 14,
      aMin,
      aMax,
      size: nodeSize(s),
      opacity: opacityFor(s),
    };
  });

  relax(nodes, MIN_SEPARATION);

  const placements: Placement[] = nodes.map((n) => ({ id: n.id, dx: n.x, dy: n.y, zone: n.zone, size: n.size, opacity: n.opacity }));
  const usedZones = [...new Set(nodes.map((n) => n.zone))].sort() as Zone[];
  const extent = nodes.reduce((m, n) => Math.max(m, Math.hypot(n.x, n.y) + n.size), ZONES[0][1] * scale);
  return {
    placements,
    extent,
    zones: usedZones.map((z) => ({ zone: z, radius: z === 1 ? ZONES[1][1] * scale : ((ZONES[z][0] + ZONES[z][1]) / 2) * scale })),
    sectors: present.map((p, i) => ({ provider: p, start: rotation + starts[i], end: rotation + starts[i] + widthOf(i) })),
  };
}

/**
 * Deterministic collision relaxation. Pairs closer than `minSep` are pushed apart, then each
 * node is clamped back into its zone and provider sector, so meaning is preserved.
 */
function relax(nodes: Working[], minSep: number) {
  const n = nodes.length;
  for (let iter = 0; iter < 60; iter++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = nodes[i];
        const b = nodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        if (d >= minSep) continue;
        if (d < 1e-6) {
          const t = unit(a.id + b.id, "split") * Math.PI * 2;
          dx = Math.cos(t);
          dy = Math.sin(t);
          d = 1;
        }
        const push = (minSep - d) / 2;
        const ux = dx / d;
        const uy = dy / d;
        a.x -= ux * push;
        a.y -= uy * push;
        b.x += ux * push;
        b.y += uy * push;
        moved = true;
      }
    }
    for (const node of nodes) constrain(node);
    if (!moved) break;
  }
}

function constrain(node: Working) {
  let r = Math.hypot(node.x, node.y);
  let a = Math.atan2(node.y, node.x);
  const width = node.aMax - node.aMin;
  let rel = normalizeAngle(a - node.aMin);
  if (rel > width) rel = rel - width < Math.PI * 2 - rel ? width : 0;
  a = node.aMin + rel;
  r = Math.max(node.rMin, Math.min(node.rMax, r));
  node.x = Math.cos(a) * r;
  node.y = Math.sin(a) * r;
}

/**
 * Galaxy position for a project slot: a golden-angle (phyllotaxis) spiral with a small
 * hash-derived offset. `spacing` scales the whole spiral uniformly, so tightening the
 * galaxy never changes the arrangement — only its size.
 */
export function slotPosition(slot: number, key: string, spacing: number): { x: number; y: number } {
  if (slot <= 0) return { x: 0, y: 0 };
  const golden = Math.PI * (3 - Math.sqrt(5));
  const r = spacing * Math.sqrt(slot - 0.6);
  const theta = slot * golden - Math.PI / 2;
  const jitter = spacing * 0.12;
  return {
    x: Math.cos(theta) * r * 1.12 + (unit(key, "jx") - 0.5) * 2 * jitter,
    y: Math.sin(theta) * r * 0.8 + (unit(key, "jy") - 0.5) * 2 * jitter,
  };
}

/** Spiral spacing that fits the largest visible system with room for its label. */
export function galaxySpacing(maxExtent: number): number {
  return Math.max(205, Math.min(700, maxExtent * GALAXY_SCALE * 2 + 92));
}

/** Interaction weight from provider metadata; turns are a decent proxy for importance. */
export function weightFromMetadata(meta: Record<string, unknown> | null | undefined): number {
  const turns = Number(meta?.userTurns ?? 0);
  const tokens = Number(meta?.tokensUsed ?? 0);
  const fromTurns = turns > 0 ? Math.log1p(turns) / Math.log1p(80) : 0;
  const fromTokens = tokens > 0 ? Math.log10(1 + tokens) / 7 : 0;
  return Math.min(1, Math.max(fromTurns, fromTokens));
}
