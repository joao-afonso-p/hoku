import { useEffect, useRef } from "react";
import { unit } from "../../lib/hash";
import type { Camera } from "./camera";

/**
 * The Galaxy's background: deep space as an information canvas, never wallpaper. Three layers,
 * far to near — a few huge diffuse glows, sparse fine dust, faint stars — each with its own
 * (small) camera parallax so the sky reads as depth, not content.
 *
 * Ambience "subtle" adds a slow drift (≈ 1.6 px/s at most, from incommensurate sines so it never
 * visibly loops) and a cursor parallax that is strongest on a sparse near-star layer. Only the background moves;
 * project and session nodes never do. "still" and prefers-reduced-motion draw the same layers
 * without motion. Glow brightness was tuned down twice after it first "looked right"; motion
 * amplitude was tuned up twice (see LAYERS and docs/constellation-layout.md → Background).
 */
export type Ambience = "still" | "subtle";
export const AMBIENCE_KEY = "galaxy.ambience";
export const DEFAULT_AMBIENCE: Ambience = "subtle";

export function ambienceFromSettings(settings: Record<string, unknown>): Ambience {
  const v = settings[AMBIENCE_KEY];
  return v === "still" || v === "subtle" ? v : DEFAULT_AMBIENCE;
}

const TILE = 900;
const STARS = Array.from({ length: 70 }, (_, i) => ({
  x: unit(String(i), "sx") * TILE,
  y: unit(String(i), "sy") * TILE,
  r: 0.35 + unit(String(i), "sr") ** 3 * 0.9,
  a: 0.04 + unit(String(i), "sa") ** 2 * 0.16,
}));
/**
 * A sparse near layer: fewer, slightly brighter stars that move more. The two star layers
 * sliding past each other is what reads as depth when the cursor or the drift moves.
 */
const NEAR_TILE = 1300;
const NEAR = Array.from({ length: 16 }, (_, i) => ({
  x: unit(String(i), "nx") * NEAR_TILE,
  y: unit(String(i), "ny") * NEAR_TILE,
  r: 0.55 + unit(String(i), "nr") ** 2 * 0.7,
  a: 0.1 + unit(String(i), "na") * 0.16,
}));

/** Diffuse light fields: position as a fraction of the viewport, size as a fraction of its diagonal. */
const GLOWS = [
  { fx: 0.24, fy: 0.3, size: 0.55, rgb: [241, 234, 216], a: 0.009 },
  { fx: 0.78, fy: 0.64, size: 0.62, rgb: [150, 168, 205], a: 0.008 },
  { fx: 0.55, fy: 0.08, size: 0.42, rgb: [160, 146, 190], a: 0.0055 },
];

/**
 * At these alphas an 8-bit gradient has only 4–5 steps and bands into visible rings. So the
 * glows are computed once per size at ¼ resolution with dithering, then scaled up smoothly.
 */
const GLOW_SCALE = 4;
/** Extra low-res pixels around the viewport (per side) so the glow can travel without showing its edge. */
const GLOW_PAD = 8;
let glowCache: { key: string; canvas: HTMLCanvasElement } | null = null;
function glowLayer(width: number, height: number): HTMLCanvasElement {
  const w = Math.max(1, Math.ceil(width / GLOW_SCALE) + 2 * GLOW_PAD);
  const h = Math.max(1, Math.ceil(height / GLOW_SCALE) + 2 * GLOW_PAD);
  const key = `${w}x${h}`;
  if (glowCache?.key === key) return glowCache.canvas;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  const img = g.createImageData(w, h);
  const diag = Math.hypot(w, h);
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0, r = 0, gg = 0, b = 0;
      for (const glow of GLOWS) {
        const d = Math.hypot(x - glow.fx * w, y - glow.fy * h) / (glow.size * diag);
        if (d >= 1) continue;
        const k = glow.a * (1 - d) ** 2.2; // soft, no visible edge
        a += k;
        r += glow.rgb[0] * k;
        gg += glow.rgb[1] * k;
        b += glow.rgb[2] * k;
      }
      const i = (y * w + x) * 4;
      if (a > 0) {
        img.data[i] = r / a;
        img.data[i + 1] = gg / a;
        img.data[i + 2] = b / a;
      }
      img.data[i + 3] = Math.max(0, Math.round(a * 255 + rand()));
    }
  }
  g.putImageData(img, 0, 0);
  glowCache = { key, canvas: c };
  return c;
}

/**
 * Galaxy ambience tuning — the one place to change how alive the sky feels. Per layer: camera
 * parallax, drift amplitude (px), cursor parallax (px), drift periods (s). Camera parallax is
 * not ambience (it follows pans in Still too). The glow layer's drift and cursor are applied
 * at GLOW_TRAVEL of their value, so its real travel is ~⅓ of the number here.
 *
 * Raise amplitude, not speed: when drift grows, stretch the periods too, so the sky travels
 * further but stays slow. History:
 *   1st pass: ≤ 5 px, < 0.2 px/s — below perception.
 *   2nd pass: drift 18/7/9/14, cursor 6/7/11/22, periods 71–211 s (near ≈ 1.1 px/s) — still
 *             too subtle to read as intentional.
 *   3rd pass (now): drift ×2.2–2.6, periods ×1.6, cursor ×1.6–2 (near ≈ 1.6 px/s).
 */
const LAYERS = {
  glow: { parallax: 0.05, drift: 40, cursor: 12, periods: [211, 337, 277, 157] },
  dust: { parallax: 0.1, drift: 18, cursor: 13, periods: [139, 239, 181, 317] },
  stars: { parallax: 0.18, drift: 22, cursor: 20, periods: [127, 211, 163, 263] },
  near: { parallax: 0.3, drift: 34, cursor: 36, periods: [113, 181, 139, 223] },
} as const;
/** Glows are far away: they take this fraction of their layer offset. */
const GLOW_TRAVEL = 0.3;

const DUST_TILE = 512;
let dustCanvas: HTMLCanvasElement | null = null;
/** Sparse, irregular grain, rendered once and tiled. */
function dust(): HTMLCanvasElement {
  if (dustCanvas) return dustCanvas;
  const c = document.createElement("canvas");
  c.width = DUST_TILE;
  c.height = DUST_TILE;
  const g = c.getContext("2d")!;
  for (let i = 0; i < 520; i++) {
    const a = 0.008 + unit(String(i), "da") ** 2 * 0.024;
    g.fillStyle = `rgba(236, 232, 222, ${a})`;
    const r = 0.3 + unit(String(i), "dr") * 0.5;
    g.beginPath();
    g.arc(unit(String(i), "dx") * DUST_TILE, unit(String(i), "dy") * DUST_TILE, r, 0, Math.PI * 2);
    g.fill();
  }
  dustCanvas = c;
  return c;
}

/** Barely perceptible wander: two slow sines per axis, periods chosen so the sum never repeats visibly. */
export function drift(t: number, amp: number, [p1, p2, p3, p4]: readonly number[]): [number, number] {
  const tau = Math.PI * 2;
  return [amp * (0.62 * Math.sin((tau * t) / p1) + 0.38 * Math.sin((tau * t) / p2 + 1.7)), amp * (0.62 * Math.sin((tau * t) / p3 + 0.9) + 0.38 * Math.sin((tau * t) / p4 + 2.4))];
}

function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

export function Starfield({ cam, width, height, ambience }: { cam: Camera; width: number; height: number; ambience: Ambience }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const camRef = useRef(cam);
  camRef.current = cam;
  const cursor = useRef({ x: 0, y: 0, tx: 0, ty: 0 });
  const drawRef = useRef<(t: number) => void>(() => {});

  drawRef.current = (t: number) => {
    const canvas = ref.current;
    if (!canvas || width === 0) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    }
    const g = canvas.getContext("2d");
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, height);
    const c = camRef.current;
    const k = cursor.current;
    const offset = (layer: (typeof LAYERS)[keyof typeof LAYERS]): [number, number] => {
      const [dx, dy] = t ? drift(t, layer.drift, layer.periods) : [0, 0];
      return [-c.x * c.zoom * layer.parallax + dx + k.x * layer.cursor, -c.y * c.zoom * layer.parallax + dy + k.y * layer.cursor];
    };

    // Glows: huge and soft, anchored to the viewport so they never read as objects. Far away,
    // so they shift only a little with the camera, and never wrap.
    const [gx, gy] = offset(LAYERS.glow);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = "high";
    const glows = glowLayer(width, height);
    const m = GLOW_PAD * GLOW_SCALE;
    g.drawImage(glows, -m + gx * GLOW_TRAVEL, -m + gy * GLOW_TRAVEL, glows.width * GLOW_SCALE, glows.height * GLOW_SCALE);

    // Dust.
    const [dx, dy] = offset(LAYERS.dust);
    const ox = ((dx % DUST_TILE) + DUST_TILE) % DUST_TILE;
    const oy = ((dy % DUST_TILE) + DUST_TILE) % DUST_TILE;
    const tile = dust();
    for (let tx = ox - DUST_TILE; tx < width; tx += DUST_TILE) for (let ty = oy - DUST_TILE; ty < height; ty += DUST_TILE) g.drawImage(tile, tx, ty);

    // Stars.
    const [sx, sy] = offset(LAYERS.stars);
    const scale = 0.85 + Math.min(c.zoom, 2) * 0.15;
    const px = ((sx % TILE) + TILE) % TILE;
    const py = ((sy % TILE) + TILE) % TILE;
    g.fillStyle = "#f4efe2";
    for (let tx = -TILE; tx < width + TILE; tx += TILE) {
      for (let ty = -TILE; ty < height + TILE; ty += TILE) {
        for (const s of STARS) {
          const x = s.x + px + tx;
          const y = s.y + py + ty;
          if (x < -2 || y < -2 || x > width + 2 || y > height + 2) continue;
          g.globalAlpha = s.a;
          g.beginPath();
          g.arc(x, y, s.r * scale, 0, Math.PI * 2);
          g.fill();
        }
      }
    }
    // Near stars.
    const [nx, ny] = offset(LAYERS.near);
    const qx = ((nx % NEAR_TILE) + NEAR_TILE) % NEAR_TILE;
    const qy = ((ny % NEAR_TILE) + NEAR_TILE) % NEAR_TILE;
    for (let tx = -NEAR_TILE; tx < width + NEAR_TILE; tx += NEAR_TILE) {
      for (let ty = -NEAR_TILE; ty < height + NEAR_TILE; ty += NEAR_TILE) {
        for (const s of NEAR) {
          const x = s.x + qx + tx;
          const y = s.y + qy + ty;
          if (x < -3 || y < -3 || x > width + 3 || y > height + 3) continue;
          g.globalAlpha = s.a;
          g.beginPath();
          g.arc(x, y, s.r * scale, 0, Math.PI * 2);
          g.fill();
        }
      }
    }
    g.globalAlpha = 1;
  };

  const moving = ambience === "subtle" && !reducedMotion();
  // Dev: draw a chosen moment (background windows get no rAF, so snapshots need this).
  if (import.meta.env.DEV)
    (window as unknown as { __sky: unknown }).__sky = (t: number, cx = 0, cy = 0) => {
      cursor.current = { x: cx, y: cy, tx: cx, ty: cy };
      drawRef.current(t);
    };

  // Still: draw when the camera or size changes.
  useEffect(() => {
    if (!moving) drawRef.current(0);
  }, [moving, cam.x, cam.y, cam.zoom, width, height]);

  // Subtle: a gentle loop (~30 fps), paused while the window is hidden.
  useEffect(() => {
    if (!moving) {
      cursor.current = { x: 0, y: 0, tx: 0, ty: 0 };
      return;
    }
    const onMove = (e: PointerEvent) => {
      // -1 … 1 from the centre; eased toward in the loop so parallax never jumps.
      cursor.current.tx = (e.clientX / window.innerWidth) * 2 - 1;
      cursor.current.ty = (e.clientY / window.innerHeight) * 2 - 1;
    };
    window.addEventListener("pointermove", onMove);
    let raf = 0;
    let last = 0;
    const start = performance.now() - unit("hoku", "t0") * 600_000;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (now - last < 33 || document.hidden) return;
      last = now;
      const k = cursor.current;
      k.x += (k.tx - k.x) * 0.035;
      k.y += (k.ty - k.y) * 0.035;
      drawRef.current((now - start) / 1000);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove);
    };
  }, [moving]);

  return <canvas ref={ref} className="pointer-events-none absolute inset-0" style={{ width, height }} />;
}
