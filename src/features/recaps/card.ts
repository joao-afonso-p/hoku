import mark from "../../assets/hoku-mark-96.png";
import { unit } from "../../lib/hash";
import { PROVIDERS } from "../../providers";
import { glyphPath } from "../constellation/Glyph";
import { FORMATS, type CardContent } from "./share";

/**
 * The share card, drawn with Canvas 2D. One renderer serves both the preview and the PNG
 * export, so what you see is exactly what you share. No DOM snapshotting, no remote fonts:
 * the system font, Hoku's graphite and starlight palette, and a constellation of the
 * recap's projects.
 *
 * Sizes are in card units (1200 × 630, 1080 × 1080, 1080 × 1350). Text is sized for the
 * image being shown at roughly half width in a feed: body copy stays ≥ 26 units.
 */

const FONT = `-apple-system, "SF Pro Display", "SF Pro Text", "Helvetica Neue", system-ui, sans-serif`;
const C = {
  void: "#0a0b0e",
  ink: "#e8e9eb",
  ink2: "#a9adb5",
  ink3: "#71767f",
  ink4: "#565a63",
  star: "#f1ead8",
};

export type Measure = (text: string) => number;

/**
 * Greedy word wrap. Words longer than a line are broken; overflow past `maxLines` ends the
 * last line with an ellipsis. Pure, so it's testable without a canvas.
 */
export function wrapLines(text: string, maxWidth: number, maxLines: number, measure: Measure): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  const push = (l: string) => lines.push(l);
  for (let i = 0; i < words.length; i++) {
    let word = words[i];
    // Break a single overlong word into pieces that fit.
    while (measure(word) > maxWidth && word.length > 1) {
      let cut = word.length - 1;
      while (cut > 1 && measure((line ? `${line} ` : "") + word.slice(0, cut)) > maxWidth) cut--;
      if (line && measure(`${line} ${word.slice(0, cut)}`) > maxWidth) {
        push(line);
        line = "";
        continue;
      }
      push((line ? `${line} ` : "") + word.slice(0, cut));
      line = "";
      word = word.slice(cut);
    }
    const next = line ? `${line} ${word}` : word;
    if (measure(next) <= maxWidth) line = next;
    else {
      push(line);
      line = word;
    }
  }
  if (line) push(line);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1];
  while (last.length > 0 && measure(`${last}…`) > maxWidth) last = last.slice(0, -1).trimEnd();
  kept[maxLines - 1] = `${last.replace(/[\s,.;:–-]+$/, "")}…`;
  return kept;
}

let markImage: Promise<HTMLImageElement | null> | null = null;
/** The Hoku mark, bundled with the app (same origin, so the canvas stays exportable). */
export function loadMark(): Promise<HTMLImageElement | null> {
  markImage ??= new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = mark;
  });
  return markImage;
}

type Ctx = CanvasRenderingContext2D;

function font(ctx: Ctx, size: number, weight = 400) {
  ctx.font = `${weight} ${size}px ${FONT}`;
}

function spacing(ctx: Ctx, px: number) {
  if ("letterSpacing" in ctx) (ctx as Ctx & { letterSpacing: string }).letterSpacing = `${px}px`;
}

function measureWith(ctx: Ctx): Measure {
  return (t) => ctx.measureText(t).width;
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, h / 2, w / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function rgba(hex: string, a: number): string {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.replace(/./g, "$&$&") : h.slice(0, 6), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function background(ctx: Ctx, w: number, h: number) {
  ctx.fillStyle = C.void;
  ctx.fillRect(0, 0, w, h);
  const glows: [number, number, number, string, number][] = [
    [0.18, 0.12, 0.75, "#f1ead8", 0.075],
    [0.86, 0.78, 0.7, "#96a8cd", 0.07],
    [0.62, -0.05, 0.5, "#a092be", 0.045],
  ];
  const d = Math.hypot(w, h);
  for (const [fx, fy, size, color, a] of glows) {
    const g = ctx.createRadialGradient(fx * w, fy * h, 0, fx * w, fy * h, size * d);
    g.addColorStop(0, rgba(color, a));
    g.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
  const n = Math.round((w * h) / 7000);
  for (let i = 0; i < n; i++) {
    const r = 0.5 + unit(String(i), "card-r") ** 3 * 1.4;
    ctx.fillStyle = rgba(C.star, 0.06 + unit(String(i), "card-a") ** 2 * 0.34);
    ctx.beginPath();
    ctx.arc(unit(String(i), "card-x") * w, unit(String(i), "card-y") * h, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** A four-point sparkle: Hoku's bullet for outcomes. */
function sparkle(ctx: Ctx, x: number, y: number, r: number, color: string) {
  ctx.fillStyle = color;
  ctx.beginPath();
  const k = r * 0.28;
  ctx.moveTo(x, y - r);
  ctx.quadraticCurveTo(x + k, y - k, x + r, y);
  ctx.quadraticCurveTo(x + k, y + k, x, y + r);
  ctx.quadraticCurveTo(x - k, y + k, x - r, y);
  ctx.quadraticCurveTo(x - k, y - k, x, y - r);
  ctx.fill();
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Projects as star systems on a golden-angle spiral, joined by faint constellation lines. */
function constellation(ctx: Ctx, c: CardContent, box: Box, labelSize: number) {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2 - (c.projects.some((p) => p.label) ? labelSize * 0.5 : 0);
  const n = c.projects.length;
  const spread = Math.min(box.w, box.h) * 0.42;
  const unitSize = Math.min(box.w, box.h) / 300;
  const pts = c.projects.map((p, i) => {
    const a = i * 2.39996 - Math.PI / 2 + 0.6;
    const rad = n === 1 ? 0 : spread * Math.sqrt((i + 0.7) / n);
    // Landscape boxes are wider than tall: stretch the spiral to use the space.
    const sx = box.w > box.h ? Math.min(1.7, box.w / box.h) : 1;
    return { ...p, x: cx + Math.cos(a) * rad * sx, y: cy + Math.sin(a) * rad * 0.92 };
  });

  if (n === 0) {
    // Only unsorted work: a lone, quiet star.
    sparkle(ctx, cx, cy, 14 * unitSize, rgba(C.star, 0.8));
    return;
  }

  ctx.strokeStyle = rgba(C.star, 0.13);
  ctx.lineWidth = 1.4 * unitSize;
  ctx.beginPath();
  pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.stroke();

  for (const p of pts) {
    const core = (5 + 8 * p.weight) * unitSize;
    const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, core * 5);
    glow.addColorStop(0, rgba(p.color, 0.3));
    glow.addColorStop(1, rgba(p.color, 0));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(p.x, p.y, core * 5, 0, Math.PI * 2);
    ctx.fill();

    // Orbiting sessions, for texture: how many is a feel, not a number.
    const orbit = core * 2.6;
    ctx.strokeStyle = rgba(p.color, 0.18);
    ctx.lineWidth = 1 * unitSize;
    ctx.beginPath();
    ctx.arc(p.x, p.y, orbit, 0, Math.PI * 2);
    ctx.stroke();
    const moons = 2 + Math.round(p.weight * 5);
    for (let m = 0; m < moons; m++) {
      const a = (m / moons) * Math.PI * 2 + unit(`${p.x}`, "moon") * 6;
      ctx.fillStyle = rgba(p.color, 0.75);
      ctx.beginPath();
      ctx.arc(p.x + Math.cos(a) * orbit, p.y + Math.sin(a) * orbit, 1.9 * unitSize, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.strokeStyle = rgba(p.color, 0.95);
    ctx.lineWidth = 2 * unitSize;
    ctx.beginPath();
    ctx.arc(p.x, p.y, core, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = rgba(C.star, 0.95);
    ctx.beginPath();
    ctx.arc(p.x, p.y, core * 0.42, 0, Math.PI * 2);
    ctx.fill();

    if (p.label) {
      font(ctx, labelSize, 500);
      spacing(ctx, 0);
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.lineWidth = 5;
      ctx.lineJoin = "round";
      ctx.strokeStyle = C.void;
      const label = wrapLines(p.label, box.w * 0.45, 1, measureWith(ctx))[0] ?? "";
      ctx.strokeText(label, p.x, p.y + orbit + 8 * unitSize);
      ctx.fillStyle = C.ink2;
      ctx.fillText(label, p.x, p.y + orbit + 8 * unitSize);
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
    }
  }
}

/** One bar per day. Days Hoku's runtime history covers are bright; the rest are dimmer. */
function dayStrip(ctx: Ctx, c: CardContent, box: Box) {
  const n = c.days.length;
  if (!n) return;
  const gap = n > 45 ? 2 : n > 20 ? 4 : 8;
  const bw = (box.w - gap * (n - 1)) / n;
  c.days.forEach((d, i) => {
    const x = box.x + i * (bw + gap);
    if (d.level <= 0) {
      ctx.fillStyle = rgba(C.star, 0.1);
      roundRect(ctx, x, box.y + box.h - 3, bw, 3, 1.5);
      ctx.fill();
      return;
    }
    const h = Math.max(5, Math.sqrt(d.level) * box.h);
    ctx.fillStyle = rgba(C.star, d.observed ? 0.78 : 0.34);
    roundRect(ctx, x, box.y + box.h - h, bw, h, Math.min(3, bw / 2));
    ctx.fill();
  });
}

function providerMix(ctx: Ctx, c: CardContent, box: Box, size: number) {
  if (!c.providers.length) return 0;
  let x = box.x;
  const barH = Math.max(6, size * 0.34);
  c.providers.forEach((p, i) => {
    const w = Math.max(barH, p.share * box.w - (i < c.providers.length - 1 ? 4 : 0));
    ctx.fillStyle = rgba(p.accent, 0.9);
    roundRect(ctx, x, box.y, w, barH, barH / 2);
    ctx.fill();
    x += w + 4;
  });
  font(ctx, size, 500);
  spacing(ctx, 0);
  ctx.textBaseline = "middle";
  let lx = box.x;
  const ly = box.y + barH + size * 1.25;
  for (const p of c.providers) {
    const r = size * 0.3;
    const path = new Path2D(glyphPath(PROVIDERS[p.provider].glyph, lx + r, ly, r));
    ctx.fillStyle = p.accent;
    ctx.fill(path);
    ctx.fillStyle = C.ink2;
    ctx.fillText(p.label, lx + r * 2 + size * 0.4, ly);
    lx += r * 2 + size * 0.4 + ctx.measureText(p.label).width + size * 1.2;
  }
  ctx.textBaseline = "alphabetic";
  return barH + size * 2;
}

function stats(ctx: Ctx, c: CardContent, x: number, baseline: number, valueSize: number, maxWidth: number) {
  let cx = x;
  const gap = valueSize * 0.95;
  for (const s of c.stats) {
    font(ctx, valueSize, 600);
    spacing(ctx, 0);
    const vw = ctx.measureText(s.value).width;
    font(ctx, valueSize * 0.34, 600);
    spacing(ctx, valueSize * 0.04);
    const lw = ctx.measureText(s.label.toUpperCase()).width;
    const w = Math.max(vw, lw);
    if (cx + w > x + maxWidth) break;
    font(ctx, valueSize, 600);
    spacing(ctx, 0);
    ctx.fillStyle = C.ink;
    ctx.fillText(s.value, cx, baseline);
    font(ctx, valueSize * 0.34, 600);
    spacing(ctx, valueSize * 0.04);
    ctx.fillStyle = C.ink3;
    ctx.fillText(s.label.toUpperCase(), cx, baseline + valueSize * 0.62);
    cx += w + gap;
  }
  spacing(ctx, 0);
}

function header(ctx: Ctx, c: CardContent, x: number, y: number, size: number, markImg: HTMLImageElement | null) {
  let tx = x;
  if (c.attribution && markImg) {
    const m = size * 1.7;
    ctx.drawImage(markImg, x, y - m * 0.72, m, m);
    tx += m + size * 0.6;
  }
  font(ctx, size, 600);
  spacing(ctx, size * 0.16);
  ctx.fillStyle = C.ink3;
  ctx.fillText(c.period.toUpperCase(), tx, y);
  spacing(ctx, 0);
}

/**
 * Two-line headlines are balanced: the narrowest width that still fits in two lines, so a
 * lone word never dangles on the second line.
 */
export function balancedLines(text: string, width: number, measure: Measure): string[] {
  const lines = wrapLines(text, width, 2, measure);
  if (lines.length < 2 || wrapLines(text, width, 3, measure).length > 2) return lines;
  let lo = width * 0.4;
  let hi = width;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    if (wrapLines(text, mid, 3, measure).length <= 2) hi = mid;
    else lo = mid;
  }
  return wrapLines(text, hi, 2, measure);
}

/** Up to two lines of headline from `y` (top). Returns the y below it. */
function headline(ctx: Ctx, text: string, x: number, y: number, width: number, size: number) {
  font(ctx, size, 650);
  spacing(ctx, -size * 0.012);
  ctx.fillStyle = C.ink;
  let cy = y;
  for (const line of balancedLines(text, width, measureWith(ctx))) {
    ctx.fillText(line, x, cy + size);
    cy += size * 1.14;
  }
  spacing(ctx, 0);
  return cy;
}

function headlineHeight(ctx: Ctx, text: string, width: number, size: number) {
  font(ctx, size, 650);
  spacing(ctx, -size * 0.012);
  const n = wrapLines(text, width, 2, measureWith(ctx)).length;
  spacing(ctx, 0);
  return n * size * 1.14;
}

function outcomesHeight(ctx: Ctx, items: string[], width: number, size: number) {
  font(ctx, size, 450);
  spacing(ctx, 0);
  const measure = measureWith(ctx);
  const lh = size * 1.32;
  return items.reduce((hgt, o) => hgt + size * 1.1 + (wrapLines(o, width - size * 1.25, 2, measure).length - 1) * lh + size * 0.55, 0);
}

/** Outcomes from `y` (top), as many as fit whole above `limit`. */
function outcomes(ctx: Ctx, items: string[], x: number, y: number, width: number, limit: number, size: number) {
  font(ctx, size, 450);
  spacing(ctx, 0);
  const measure = measureWith(ctx);
  const lh = size * 1.32;
  const indent = size * 1.25;
  let cy = y;
  for (const o of items) {
    const lines = wrapLines(o, width - indent, 2, measure);
    const needed = size * 1.1 + (lines.length - 1) * lh;
    if (cy + needed > limit) break;
    sparkle(ctx, x + size * 0.36, cy + size * 0.6, size * 0.34, C.star);
    ctx.fillStyle = C.ink;
    lines.forEach((l, i) => ctx.fillText(l, x + indent, cy + size * 0.92 + i * lh));
    cy += needed + size * 0.55;
  }
  return cy;
}

function footer(ctx: Ctx, c: CardContent, x: number, right: number, baseline: number, size: number) {
  font(ctx, size, 450);
  spacing(ctx, 0);
  ctx.fillStyle = C.ink4;
  ctx.textAlign = "left";
  ctx.fillText(c.footnote, x, baseline);
  if (c.attribution) {
    ctx.textAlign = "right";
    ctx.fillStyle = C.ink3;
    ctx.fillText(c.attribution, right, baseline);
    ctx.textAlign = "left";
  }
}

function landscape(ctx: Ctx, c: CardContent, w: number, h: number, markImg: HTMLImageElement | null) {
  const pad = 60;
  const split = 700;
  header(ctx, c, pad, pad + 20, 17, markImg);
  const statsBaseline = h - 124;
  const below = headline(ctx, c.headline, pad, pad + 48, split - pad, c.outcomes.length ? 48 : 58);
  outcomes(ctx, c.outcomes, pad, below + 22, split - pad, statsBaseline - 76, 27);
  stats(ctx, c, pad, statsBaseline, 50, split - pad);

  const right: Box = { x: split + 50, y: pad, w: w - pad - split - 50, h: 300 };
  constellation(ctx, c, right, 19);
  let y = right.y + right.h + 30;
  if (c.days.length) {
    dayStrip(ctx, c, { x: right.x, y, w: right.w, h: 46 });
    y += 46 + 30;
  }
  providerMix(ctx, c, { x: right.x, y, w: right.w, h: 0 }, 17);
  footer(ctx, c, pad, w - pad, h - 44, 16);
}

/**
 * Square and portrait, top to bottom: header, headline, constellation, outcomes; then the day
 * strip, numbers, provider mix and footer anchored to the bottom. The constellation takes
 * whatever height is left, so short and long recaps both fill the card.
 */
function tall(ctx: Ctx, c: CardContent, w: number, h: number, markImg: HTMLImageElement | null) {
  const pad = 76;
  const inner = w - pad * 2;
  header(ctx, c, pad, pad + 24, 21, markImg);

  const footerBaseline = h - 60;
  const valueSize = 58;
  // Stat labels sit ~0.7 × value below the baseline; the provider bar and legend below them.
  const statsBaseline = c.providers.length ? footerBaseline - 150 : footerBaseline - 84;
  const stripH = c.days.length ? 44 : 0;
  const stripY = statsBaseline - valueSize - 34 - stripH;
  const contentBottom = (stripH ? stripY : statsBaseline - valueSize) - 34;

  const hlSize = c.outcomes.length ? 58 : 66;
  const headY = pad + 58;
  const consY = headY + headlineHeight(ctx, c.headline, inner, hlSize) + 22;
  const outcomeSize = 32;
  const free = contentBottom - consY - outcomesHeight(ctx, c.outcomes, inner, outcomeSize) - 20;
  const consH = Math.max(200, Math.min(h > w ? 540 : 420, free));

  headline(ctx, c.headline, pad, headY, inner, hlSize);
  constellation(ctx, c, { x: pad, y: consY, w: inner, h: consH }, 22);
  outcomes(ctx, c.outcomes, pad, consY + consH + 20, inner, contentBottom, outcomeSize);

  if (stripH) dayStrip(ctx, c, { x: pad, y: stripY, w: inner, h: stripH });
  stats(ctx, c, pad, statsBaseline, valueSize, inner);
  if (c.providers.length) providerMix(ctx, c, { x: pad, y: statsBaseline + 62, w: inner, h: 0 }, 21);
  footer(ctx, c, pad, w - pad, footerBaseline, 19);
}

/** Draw `c` at `scale` device pixels per card unit into a canvas already sized to fit. */
export function drawCard(ctx: Ctx, c: CardContent, scale: number, markImg: HTMLImageElement | null) {
  const { width: w, height: h } = FORMATS[c.format];
  ctx.save();
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  background(ctx, w, h);
  if (c.format === "landscape") landscape(ctx, c, w, h, markImg);
  else tall(ctx, c, w, h, markImg);
  ctx.restore();
}

/** Render the card at 2× into a PNG, for export and the clipboard. */
export async function renderPng(c: CardContent, scale = 2): Promise<Uint8Array> {
  const { width, height } = FORMATS[c.format];
  const canvas = document.createElement("canvas");
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw { message: "The image couldn't be drawn." };
  drawCard(ctx, c, scale, await loadMark());
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw { message: "The image couldn't be drawn." };
  return new Uint8Array(await blob.arrayBuffer());
}
