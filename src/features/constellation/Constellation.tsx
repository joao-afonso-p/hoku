import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { UNSORTED, type SystemModel } from "../../app/model";
import { useHub } from "../../app/store";
import type { Session, SessionLink } from "../../lib/types";
import { relativeTime } from "../../lib/time";
import { PROVIDERS, surfaceLabel } from "../../providers";
import { ATTENTION, CORAL, runtimeSummary, SAGE, statusKey, type StatusKey } from "../runtime/status";
import { useCamera, type Camera } from "./camera";
import { glyphPath } from "./Glyph";
import { HoverCard } from "./HoverCard";
import { clip, measure, placeLabels, type Box, type LabelRequest } from "./labels";
import { GALAXY_SCALE, ZONES } from "./layout";
import { Starfield, type Ambience } from "./Starfield";
import { useStatePulses, type Pulse } from "./motion";

export interface ConstellationProps {
  systems: SystemModel[];
  focus: string | null;
  selectedId: string | null;
  /** When set, sessions outside this set recede (drawer lists, status filter). */
  highlight: Set<string> | null;
  /** A status filter is on: non-matching sessions nearly vanish, and so do projects with no match. */
  filtering: boolean;
  links: SessionLink[];
  insetLeft: number;
  insetRight: number;
  insetTop: number;
  onSelect: (id: string | null) => void;
  onFocus: (key: string | null) => void;
  /** A project's core was clicked: show the project. */
  onCore: (key: string) => void;
  onOpen: (s: Session) => void;
  onReassign: (sessionId: string, systemKey: string) => void;
  mode: "current" | "all";
  recentWindowDays: number;
  ambience: Ambience;
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const STAR = "#f1ead8";
/** Older-zone labels only appear on hover when a project has more than this many. */
const OLDER_LABEL_LIMIT = 8;
const TITLE_FONT = "500 12px -apple-system, BlinkMacSystemFont, system-ui";
const META_FONT = "400 10.5px -apple-system, BlinkMacSystemFont, system-ui";
const SMALL_FONT = "500 11px -apple-system, BlinkMacSystemFont, system-ui";
/** Label priority by runtime state: what needs you wins the space. */
const LABEL_PRIORITY: Record<StatusKey, number> = { needs_you: 700, error: 600, working: 500, ready: 380, idle: 300, offline: 0, unknown: 0 };

interface NodeScreen {
  session: Session;
  system: SystemModel;
  x: number;
  y: number;
  r: number;
  opacity: number;
  dx: number;
  zone: number;
}

export function Constellation(props: ConstellationProps) {
  const { systems, focus, selectedId, highlight, links, insetLeft, insetRight, insetTop } = props;
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const { cam, camRef, set, animateTo } = useCamera({ x: 0, y: 0, zoom: 0.6, t: 0 });
  const [renderFocus, setRenderFocus] = useState<string | null>(focus);
  const [hover, setHover] = useState<{ kind: "session" | "system"; id: string } | null>(null);
  const [drag, setDrag] = useState<{ id: string; x: number; y: number; target: string | null } | null>(null);
  const galaxyCam = useRef<Camera | null>(null);
  const userMoved = useRef(false);
  const ready = size.w > 0;

  // ───── sizing ─────
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);


  const bySystem = useMemo(() => new Map(systems.map((s) => [s.key, s])), [systems]);
  const drawn = useMemo(() => systems.flatMap((s) => s.visible), [systems]);
  const pulses = useStatePulses(drawn);

  // ───── camera targets ─────
  const galaxyFit = useCallback((): Camera => {
    if (systems.length === 0) return { x: 0, y: 0, zoom: 1, t: 0 };
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const s of systems) {
      const e = s.layout.extent * GALAXY_SCALE + 46;
      x0 = Math.min(x0, s.x - e);
      x1 = Math.max(x1, s.x + e);
      y0 = Math.min(y0, s.y - e);
      y1 = Math.max(y1, s.y + e + 30);
    }
    const availW = Math.max(200, size.w - insetLeft - 120);
    const availH = Math.max(200, size.h - insetTop - 110);
    const zoom = clamp(Math.min(availW / (x1 - x0), availH / (y1 - y0)), 0.28, 2.1);
    const desiredX = insetLeft + (size.w - insetLeft) / 2;
    const desiredY = insetTop + (size.h - insetTop - 40) / 2;
    return {
      x: (x0 + x1) / 2 - (desiredX - size.w / 2) / zoom,
      y: (y0 + y1) / 2 - (desiredY - size.h / 2) / zoom,
      zoom,
      t: 0,
    };
  }, [systems, size, insetLeft, insetTop]);

  const focusFit = useCallback(
    (key: string): Camera | null => {
      const s = bySystem.get(key);
      if (!s) return null;
      const ext = s.layout.extent + 40;
      const availW = Math.max(240, size.w - insetLeft - insetRight - 40);
      const availH = Math.max(240, size.h - insetTop - 70);
      // Horizontal room for labels on both sides.
      const zoom = clamp(Math.min(availW / (2 * ext + 300), availH / (2 * ext)), 0.35, 1.5);
      const desiredX = insetLeft + (size.w - insetLeft - insetRight) / 2;
      const desiredY = insetTop + (size.h - insetTop) / 2;
      return { x: s.x - (desiredX - size.w / 2) / zoom, y: s.y - (desiredY - size.h / 2) / zoom, zoom, t: 1 };
    },
    [bySystem, size, insetLeft, insetRight, insetTop],
  );

  // Dev: jump straight to the resting camera (snapshots of a background window get no rAF).
  if (import.meta.env.DEV)
    (window as unknown as { __cam: unknown }).__cam = {
      cam: camRef,
      renderFocus,
      settle: () => {
        const target = focus ? focusFit(focus) : galaxyFit();
        setRenderFocus(focus);
        if (target) set(target);
      },
    };

  // First frame: jump, don't animate.
  const placed = useRef(false);
  useEffect(() => {
    if (!ready || placed.current || systems.length === 0) return;
    placed.current = true;
    const target = focus ? focusFit(focus) : galaxyFit();
    if (target) set(target);
  }, [ready, systems.length, focus, focusFit, galaxyFit, set]);

  // Focus transitions: galaxy ⇄ project, and project → project via the galaxy.
  const prevFocus = useRef(focus);
  useEffect(() => {
    if (!placed.current) return;
    const from = prevFocus.current;
    prevFocus.current = focus;
    if (from === focus) return;
    if (focus && !from) {
      if (!userMoved.current || !galaxyCam.current) galaxyCam.current = { ...camRef.current, t: 0 };
      else galaxyCam.current = { ...camRef.current, t: 0 };
      setRenderFocus(focus);
      const target = focusFit(focus);
      if (target) animateTo(target, 460);
    } else if (!focus && from) {
      const back = userMoved.current && galaxyCam.current ? galaxyCam.current : galaxyFit();
      animateTo({ ...back, t: 0 }, 380, () => setRenderFocus(null));
    } else if (focus && from) {
      const mid = galaxyCam.current ?? galaxyFit();
      animateTo({ ...mid, t: 0 }, 240, () => {
        setRenderFocus(focus);
        const target = focusFit(focus);
        if (target) animateTo(target, 420);
      });
    }
  }, [focus, focusFit, galaxyFit, animateTo, camRef]);

  // Explicit "show me everything" from the Galaxy button / ⌘0.
  const fitNonce = useHub((s) => s.fitNonce);
  const lastNonce = useRef(fitNonce);
  useEffect(() => {
    if (lastNonce.current === fitNonce) return;
    lastNonce.current = fitNonce;
    userMoved.current = false;
    galaxyCam.current = null;
    if (!focus) animateTo(galaxyFit(), 420);
  }, [fitNonce, focus, galaxyFit, animateTo]);

  // Re-frame when the available area changes (inspector opens, window resizes) or data changes.
  // Includes the focused system's extent, so revealing older sessions (or switching
  // Current ⇄ All) re-frames the view instead of pushing nodes off-screen.
  const focusExtent = focus ? Math.round(bySystem.get(focus)?.layout.extent ?? 0) : 0;
  const galaxyExtent = focus ? 0 : Math.round(systems.reduce((m, s) => m + s.layout.extent, 0));
  const frameKey = `${size.w}x${size.h}|${insetLeft}|${insetRight}|${systems.length}|${focusExtent}|${galaxyExtent}`;
  const lastFrame = useRef(frameKey);
  useEffect(() => {
    if (!placed.current || lastFrame.current === frameKey) return;
    lastFrame.current = frameKey;
    if (renderFocus && focus === renderFocus) {
      const target = focusFit(renderFocus);
      if (target) animateTo(target, 280, undefined, "out");
    } else if (!focus && !userMoved.current) {
      animateTo(galaxyFit(), 320, undefined, "out");
    }
  }, [frameKey, renderFocus, focus, focusFit, galaxyFit, animateTo]);

  // ───── geometry ─────
  const F = renderFocus ? bySystem.get(renderFocus) ?? null : null;
  const t = F ? cam.t : 0;
  const W = size.w;
  const H = size.h;
  const toScreen = (x: number, y: number): [number, number] => [(x - cam.x) * cam.zoom + W / 2, (y - cam.y) * cam.zoom + H / 2];

  const sysPos = (s: SystemModel) => {
    if (!F || s.key === F.key) return { x: s.x, y: s.y };
    const k = 1 + 3.2 * t;
    return { x: F.x + (s.x - F.x) * k, y: F.y + (s.y - F.y) * k };
  };
  // Unsorted is drawn compact: it's an inbox, not a project, and shouldn't win on volume.
  const galaxyScaleOf = (s: SystemModel) => (s.key === UNSORTED ? GALAXY_SCALE * 0.72 : GALAXY_SCALE);
  const sysScale = (s: SystemModel) => (F && s.key === F.key ? lerp(galaxyScaleOf(s), 1, t) : galaxyScaleOf(s));
  const sysAlpha = (s: SystemModel) => (F && s.key !== F.key ? Math.max(0, 1 - 1.4 * t) : 1);
  const galaxyDetail = cam.zoom * GALAXY_SCALE; // screen px per focus unit in galaxy

  const selected = selectedId ? systems.flatMap((s) => s.sessions).find((x) => x.id === selectedId) ?? null : null;
  const linkedTo = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const l of links) {
      if (!m.has(l.fromId)) m.set(l.fromId, new Set());
      if (!m.has(l.toId)) m.set(l.toId, new Set());
      m.get(l.fromId)!.add(l.toId);
      m.get(l.toId)!.add(l.fromId);
    }
    return m;
  }, [links]);

  // With a status filter, a project with nothing matching all but disappears — in place.
  const matchedSystems = useMemo(() => {
    if (!highlight) return null;
    return new Set(systems.filter((s) => s.visible.some((x) => highlight.has(x.id))).map((s) => s.key));
  }, [systems, highlight]);
  const systemFade = (s: SystemModel) => (props.filtering && matchedSystems && !matchedSystems.has(s.key) && F?.key !== s.key ? 0.16 : 1);

  const nodes: NodeScreen[] = [];
  const cores: { system: SystemModel; x: number; y: number; alpha: number; scale: number; fade: number }[] = [];
  if (ready) {
    for (const s of systems) {
      const pos = sysPos(s);
      const [sx, sy] = toScreen(pos.x, pos.y);
      const scale = sysScale(s) * cam.zoom;
      const alpha = sysAlpha(s);
      const fade = systemFade(s);
      const reach = s.layout.extent * scale + 200;
      if (alpha < 0.02 || sx < -reach || sy < -reach || sx > W + reach || sy > H + reach) continue;
      cores.push({ system: s, x: sx, y: sy, alpha, scale, fade });
      const focused = F?.key === s.key;
      const sizeK = focused ? lerp(0.72, 1, t) : clamp(0.6 + galaxyDetail * 0.5, 0.72, 1);
      const byId = new Map(s.visible.map((x) => [x.id, x]));
      // In the galaxy the project label sits below the core; sessions under it recede.
      const labelW = measure(s.name.toUpperCase(), "600 11px -apple-system, system-ui") * 1.2 + 16;
      const labelBox = { x0: sx - labelW / 2, x1: sx + labelW / 2, y0: sy + 10, y1: sy + (runtimeSummary(s.runtime) ? 58 : 44) };
      const underLabel = (x: number, y: number) => (!focused || t < 0.5) && x > labelBox.x0 && x < labelBox.x1 && y > labelBox.y0 && y < labelBox.y1;
      const systemDim = s.key === UNSORTED && !focused ? 0.6 : 1;
      for (const p of s.layout.placements) {
        const session = byId.get(p.id);
        if (!session) continue;
        let dim = 1;
        if (highlight && !highlight.has(session.id)) dim = props.filtering ? 0.14 : 0.2;
        else if (selected && selected.id !== session.id && !linkedTo.get(selected.id)?.has(session.id)) dim = focused ? 0.62 : 0.8;
        const nx = sx + p.dx * scale;
        const ny = sy + p.dy * scale;
        nodes.push({
          session,
          system: s,
          x: nx,
          y: ny,
          r: p.size * sizeK,
          opacity: p.opacity * alpha * dim * systemDim * fade * (underLabel(nx, ny) ? 0.22 : 1) * (session.runtime.state === "offline" && p.zone !== 0 ? 0.8 : 1),
          dx: p.dx,
          zone: p.zone,
        });
      }
    }
  }
  const nodeById = new Map(nodes.map((n) => [n.session.id, n]));

  // ───── labels ─────
  const hoveredSession = hover?.kind === "session" ? hover.id : null;
  const hoveredSystem = hover?.kind === "system" ? hover.id : hoveredSession ? nodeById.get(hoveredSession)?.system.key ?? null : null;
  const labelMode: "focus" | "galaxy" = F && t > 0.8 ? "focus" : "galaxy";
  const labelAlpha = labelMode === "focus" ? clamp((t - 0.8) / 0.2, 0, 1) : 1;

  // Chart annotations (orbit names, provider sectors) for the focused system.
  const chartLabels: { key: string; text: string; x: number; y: number; anchor: "start" | "middle" | "end"; color: string; opacity: number; box: Box }[] = [];
  const focusCoreScreen = F ? cores.find((c) => c.system.key === F.key) : undefined;
  if (F && focusCoreScreen && labelMode === "focus") {
    const { x, y, scale } = focusCoreScreen;
    const font = "500 9.5px -apple-system, system-ui";
    const zoneNames = ["LIVE", `RECENT · ${props.recentWindowDays} DAYS`, props.mode === "all" || F.expanded ? "OLDER" : "PINNED"];
    for (const o of F.layout.zones) {
      const text = zoneNames[o.zone];
      const w = measure(text, font) * 1.16;
      const ly = y - o.radius * scale - 6;
      const box = { x0: x - w / 2 - 3, x1: x + w / 2 + 3, y0: ly - 10, y1: ly + 3 };
      const blocked = nodes.some((n) => n.x + n.r > box.x0 && n.x - n.r < box.x1 && n.y + n.r > box.y0 && n.y - n.r < box.y1);
      if (!blocked) chartLabels.push({ key: `z${o.zone}`, text, x, y: ly, anchor: "middle", color: STAR, opacity: 0.24, box });
    }
    if (F.layout.sectors.length > 1) {
      for (const sec of F.layout.sectors) {
        const mid = (sec.start + sec.end) / 2;
        const rr = (F.layout.extent + 34) * scale;
        const lx = x + Math.cos(mid) * rr;
        const ly = y + Math.sin(mid) * rr;
        const text = PROVIDERS[sec.provider].label.toUpperCase();
        const w = measure(text, font) * 1.18;
        const anchor = Math.cos(mid) > 0.3 ? "start" : Math.cos(mid) < -0.3 ? "end" : "middle";
        const x0 = anchor === "start" ? lx : anchor === "end" ? lx - w : lx - w / 2;
        chartLabels.push({ key: sec.provider, text, x: lx, y: ly + 3, anchor, color: PROVIDERS[sec.provider].accent, opacity: 0.42, box: { x0: x0 - 3, x1: x0 + w + 3, y0: ly - 7, y1: ly + 7 } });
      }
    }
  }

  const labels = useMemo(() => {
    if (!ready) return new Map();
    const reqs: LabelRequest[] = [];
    const showAllGalaxy = galaxyDetail >= 0.5;
    const olderCount = F ? nodes.filter((n) => n.system.key === F.key && n.zone === 2).length : 0;
    for (const n of nodes) {
      const inFocus = labelMode === "focus" && n.system.key === F?.key;
      const isHover = n.session.id === hoveredSession;
      const isSel = n.session.id === selectedId;
      const systemHovered = labelMode === "galaxy" && hoveredSystem === n.system.key;
      const key = statusKey(n.session);
      const liveInGalaxy = labelMode === "galaxy" && n.zone === 0 && n.system.key !== UNSORTED && LABEL_PRIORITY[key] >= 500;
      if (!inFocus && !isHover && !isSel && !showAllGalaxy && !systemHovered && !liveInGalaxy) continue;
      // Old sessions shouldn't dominate a busy project: reveal their labels on hover only.
      if (inFocus && n.zone === 2 && olderCount > OLDER_LABEL_LIMIT && !isHover && !isSel) continue;
      if (labelMode === "focus" && !inFocus && !isHover) continue;
      if (highlight && !highlight.has(n.session.id) && !isHover && !isSel) continue;
      const title = clip(n.session.title, inFocus ? 34 : 26);
      const meta = `${surfaceLabel(n.session)} · ${metaText(n.session)}`;
      const width = inFocus ? Math.max(measure(title, TITLE_FONT), measure(meta, META_FONT)) : measure(title, SMALL_FONT);
      const live = LABEL_PRIORITY[key];
      reqs.push({
        id: n.session.id,
        x: n.x,
        y: n.y,
        r: n.r + 2,
        width,
        height: inFocus ? 30 : 15,
        preferred: n.dx >= 0 ? "right" : "left",
        priority: (isSel ? 2000 : 0) + (isHover ? 1500 : 0) + live + (2 - n.zone) * 200 + (n.session.favorite ? 150 : 0) + n.opacity * 100,
        force: isSel || isHover,
        // What needs you always gets its name on the chart — next to, never on top of, others.
        important: inFocus && (key === "needs_you" || key === "error"),
      });
    }
    const obstacles = [
      ...nodes.map((n) => ({ id: n.session.id, x: n.x, y: n.y, r: n.r + 3 })),
      ...cores.map((c) => ({ x: c.x, y: c.y + (labelMode === "galaxy" ? 12 : 0), r: labelMode === "galaxy" ? 26 : 18 })),
    ];
    return placeLabels(reqs, obstacles, { left: insetLeft, top: insetTop, width: W - insetRight, height: H }, chartLabels.map((c) => c.box));
    // `nodes`/`cores` are derived from the listed inputs every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, cam.x, cam.y, cam.zoom, cam.t, systems, labelMode, hoveredSession, hoveredSystem, selectedId, highlight, W, H, insetLeft, insetRight, insetTop]);

  // ───── interaction ─────
  const pan = useRef<{ x: number; y: number; cam: Camera; moved: boolean } | null>(null);
  const press = useRef<{ id: string; x: number; y: number; moved: boolean } | null>(null);

  const onBackgroundDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    pan.current = { x: e.clientX, y: e.clientY, cam: { ...camRef.current }, moved: false };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const onBackgroundMove = (e: React.PointerEvent) => {
    const p = pan.current;
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    if (!p.moved && Math.hypot(dx, dy) < 3) return;
    p.moved = true;
    userMoved.current = !F;
    set({ ...p.cam, x: p.cam.x - dx / p.cam.zoom, y: p.cam.y - dy / p.cam.zoom });
  };
  const onBackgroundUp = () => {
    const p = pan.current;
    pan.current = null;
    if (!p) return;
    if (!p.moved) props.onSelect(null);
    else if (!F) galaxyCam.current = { ...camRef.current, t: 0 };
  };

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const c = camRef.current;
      if (e.ctrlKey || e.metaKey) {
        const rect = el.getBoundingClientRect();
        const mx = e.clientX - rect.left - rect.width / 2;
        const my = e.clientY - rect.top - rect.height / 2;
        const zoom = clamp(c.zoom * Math.exp(-e.deltaY * 0.012), 0.2, 3);
        // Keep the world point under the cursor fixed.
        const wx = c.x + mx / c.zoom;
        const wy = c.y + my / c.zoom;
        set({ ...c, zoom, x: wx - mx / zoom, y: wy - my / zoom });
      } else {
        set({ ...c, x: c.x + e.deltaX / c.zoom, y: c.y + e.deltaY / c.zoom });
      }
      if (c.t < 0.01) {
        userMoved.current = true;
        galaxyCam.current = { ...camRef.current, t: 0 };
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [camRef, set]);

  const onNodeDown = (e: React.PointerEvent, s: Session) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    press.current = { id: s.id, x: e.clientX, y: e.clientY, moved: false };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const onNodeMove = (e: React.PointerEvent) => {
    const p = press.current;
    if (!p) return;
    if (!p.moved && Math.hypot(e.clientX - p.x, e.clientY - p.y) < 5) return;
    p.moved = true;
    if (F) return; // reassigning by drag happens in the galaxy, where targets are visible
    const rect = host.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const target = cores.find((c) => c.system.key !== UNSORTED && Math.hypot(c.x - x, c.y - y) < 30)?.system.key ?? null;
    setDrag({ id: p.id, x, y, target });
  };
  const onNodeUp = (s: Session, system: SystemModel) => {
    const p = press.current;
    press.current = null;
    const d = drag;
    setDrag(null);
    if (!p) return;
    if (!p.moved) {
      props.onSelect(s.id);
      if (!F) props.onFocus(system.key);
      return;
    }
    if (d?.target && d.target !== system.key) props.onReassign(s.id, d.target);
  };

  // ───── render ─────
  const hovered = hoveredSession ? nodeById.get(hoveredSession) : undefined;

  return (
    <div ref={host} className="absolute inset-0 overflow-hidden" style={{ cursor: pan.current?.moved ? "grabbing" : "default" }}>
      {ready && <Starfield cam={cam} width={W} height={H} ambience={props.ambience} />}
      {ready && (
        <svg
          width={W}
          height={H}
          className="absolute inset-0"
          onPointerDown={onBackgroundDown}
          onPointerMove={onBackgroundMove}
          onPointerUp={onBackgroundUp}
          onPointerLeave={() => setHover(null)}
        >
          <defs>
            <radialGradient id="core-halo">
              <stop offset="0%" stopColor={STAR} stopOpacity="0.16" />
              <stop offset="45%" stopColor={STAR} stopOpacity="0.045" />
              <stop offset="100%" stopColor={STAR} stopOpacity="0" />
            </radialGradient>
            {Object.values(PROVIDERS).map((p) => (
              <radialGradient key={p.id} id={`halo-${p.id}`}>
                <stop offset="0%" stopColor={p.accent} stopOpacity="0.55" />
                <stop offset="100%" stopColor={p.accent} stopOpacity="0" />
              </radialGradient>
            ))}
            <radialGradient id="halo-attention">
              <stop offset="0%" stopColor={ATTENTION} stopOpacity="0.5" />
              <stop offset="55%" stopColor={ATTENTION} stopOpacity="0.14" />
              <stop offset="100%" stopColor={ATTENTION} stopOpacity="0" />
            </radialGradient>
          </defs>

          {/* Orbits — the star-chart grid of each system. */}
          {cores.map(({ system, x, y, alpha, scale }) => {
            const focused = F?.key === system.key;
            const orbitAlpha = focused ? lerp(0.03, 0.055, t) : 0.028;
            const rings = focused ? system.layout.zones : system.layout.zones.slice(-1);
            return (
              <g key={`orbits-${system.key}`} opacity={alpha} pointerEvents="none">
                {rings.map((o) => (
                  <circle
                    key={o.zone}
                    cx={x}
                    cy={y}
                    r={o.radius * scale}
                    fill="none"
                    stroke={STAR}
                    strokeOpacity={orbitAlpha}
                    strokeDasharray={focused && o.zone === 2 ? "1 6" : undefined}
                  />
                ))}
              </g>
            );
          })}

          {chartLabels.map((c) => (
            <text key={c.key} x={c.x} y={c.y} textAnchor={c.anchor} fontSize={9.5} letterSpacing="0.15em" fill={c.color} opacity={c.opacity * labelAlpha} className="sky-label" pointerEvents="none">
              {c.text}
            </text>
          ))}

          {/* Tethers: faint lines to live sessions; stronger for hover / selection. */}
          <g pointerEvents="none">
            {nodes.map((n) => {
              const core = cores.find((c) => c.system.key === n.system.key);
              if (!core) return null;
              const key = statusKey(n.session);
              const live = key === "working" || key === "needs_you" || key === "error";
              const strong = n.session.id === selectedId || n.session.id === hoveredSession;
              if (!live && !strong) return null;
              return (
                <line
                  key={`t-${n.session.id}`}
                  x1={core.x}
                  y1={core.y}
                  x2={n.x}
                  y2={n.y}
                  stroke={key === "needs_you" ? ATTENTION : STAR}
                  strokeOpacity={(strong ? 0.2 : key === "needs_you" ? 0.16 : 0.07) * core.alpha * Math.min(1, n.opacity * 1.4)}
                  strokeWidth={0.8}
                />
              );
            })}
            {links.map((l) => {
              const a = nodeById.get(l.fromId);
              const b = nodeById.get(l.toId);
              if (!a || !b) return null;
              const strong = [l.fromId, l.toId].some((id) => id === selectedId || id === hoveredSession);
              return (
                <line
                  key={`l-${l.fromId}-${l.toId}`}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke={STAR}
                  strokeOpacity={strong ? 0.42 : 0.1}
                  strokeWidth={strong ? 1 : 0.7}
                  strokeDasharray={strong ? undefined : "2 4"}
                />
              );
            })}
          </g>

          {/* Sessions */}
          {nodes.map((n) => (
            <SessionNode
              key={n.session.id}
              n={n}
              pulse={pulses.get(n.session.id)}
              selected={n.session.id === selectedId}
              hovered={n.session.id === hoveredSession}
              dragging={drag?.id === n.session.id}
              onEnter={() => setHover({ kind: "session", id: n.session.id })}
              onLeave={() => setHover((h) => (h?.id === n.session.id ? null : h))}
              onDown={(e) => onNodeDown(e, n.session)}
              onMove={onNodeMove}
              onUp={() => onNodeUp(n.session, n.system)}
              onDouble={() => props.onOpen(n.session)}
            />
          ))}

          {/* Project cores */}
          {cores.map((c) => (
            <ProjectCore
              key={`core-${c.system.key}`}
              c={c}
              focused={F?.key === c.system.key}
              t={t}
              hovered={hoveredSystem === c.system.key && hover?.kind === "system"}
              dropTarget={drag?.target === c.system.key}
              mode={props.mode}
              onEnter={() => setHover({ kind: "system", id: c.system.key })}
              onLeave={() => setHover((h) => (h?.id === c.system.key ? null : h))}
              onClick={() => props.onCore(c.system.key)}
            />
          ))}

          {/* Session labels */}
          <g pointerEvents="none">
            {[...labels.entries()].map(([id, pl]) => {
              const n = nodeById.get(id);
              if (!n) return null;
              const inFocus = labelMode === "focus" && n.system.key === F?.key;
              const strong = id === selectedId || id === hoveredSession;
              const a = Math.max(strong ? 1 : 0, Math.min(1, n.opacity * 1.15)) * (inFocus ? labelAlpha : 1);
              if (!inFocus) {
                return (
                  <text key={id} x={pl.x} y={pl.y + 11} textAnchor={pl.anchor} fontSize={11} fontWeight={500} fill="#d9dbde" opacity={a} className="sky-label">
                    {clip(n.session.title, 26)}
                  </text>
                );
              }
              // A label pushed away from its node (to avoid another) gets a faint leader line,
              // so it's always clear which node it names.
              const k = statusKey(n.session);
              const displaced = (k === "needs_you" || k === "error") && Math.abs(pl.y + 15 - n.y) > n.r + 3;
              const lx = pl.anchor === "start" ? pl.x - 3 : pl.x + 3;
              const ly = pl.y + 8;
              const d = Math.hypot(lx - n.x, ly - n.y) || 1;
              return (
                <g key={id} opacity={a}>
                  {displaced && (
                    <line
                      x1={n.x + ((lx - n.x) / d) * (n.r + 4)}
                      y1={n.y + ((ly - n.y) / d) * (n.r + 4)}
                      x2={lx}
                      y2={ly}
                      stroke={metaColor(n.session)}
                      strokeOpacity={0.45}
                      strokeWidth={0.8}
                    />
                  )}
                  <text x={pl.x} y={pl.y + 12} textAnchor={pl.anchor} fontSize={12} fontWeight={500} fill={strong ? "#ffffff" : "#e3e4e7"} className="sky-label">
                    {clip(n.session.title, 34)}
                  </text>
                  <text x={pl.x} y={pl.y + 26} textAnchor={pl.anchor} fontSize={10.5} className="sky-label">
                    <tspan fill={PROVIDERS[n.session.provider].accent} fillOpacity={0.85}>
                      {surfaceLabel(n.session)}
                    </tspan>
                    <tspan fill={metaColor(n.session)}> · {metaText(n.session)}</tspan>
                  </text>
                </g>
              );
            })}
          </g>

          {/* Drag ghost */}
          {drag && (
            <g pointerEvents="none">
              <circle cx={drag.x} cy={drag.y} r={5} fill={STAR} fillOpacity={0.9} />
              <text x={drag.x + 10} y={drag.y + 4} fontSize={11} fill={STAR} className="sky-label">
                {drag.target ? `Move to ${bySystem.get(drag.target)?.name}` : "Drop on a project"}
              </text>
            </g>
          )}
        </svg>
      )}

      {F && F.sessions.length === 0 && t > 0.9 && (() => {
        const core = cores.find((c) => c.system.key === F.key);
        if (!core) return null;
        return (
          <div className="fade-in absolute w-[260px] -translate-x-1/2 text-center" style={{ left: core.x, top: core.y + 34 }}>
            <div className="text-[12.5px] text-ink-2">No sessions in {F.name} yet.</div>
            <div className="mt-1 text-[11.5px] leading-relaxed text-ink-4">
              Sessions whose folder is inside {F.project?.rootPath ? "its root" : "a project root"} join automatically when you scan. You can also add one by hand (⌘N).
            </div>
          </div>
        );
      })()}

      {hovered && !drag && <HoverCard n={hovered} width={W} height={H} />}
    </div>
  );
}

// ───── node components ─────

interface SessionNodeProps {
  n: NodeScreen;
  /** A state change that just happened: one ripple, and a brief swell into Needs You. */
  pulse?: Pulse;
  selected: boolean;
  hovered: boolean;
  dragging: boolean;
  onEnter: () => void;
  onLeave: () => void;
  onDown: (e: React.PointerEvent) => void;
  onMove: (e: React.PointerEvent) => void;
  onUp: () => void;
  onDouble: () => void;
}

/**
 * Runtime state speaks through halo, ring and luminance — never by recolouring the glyph, so
 * provider identity stays intact. Needs You: a warm, steady halo (no blinking). Error: a
 * coral ring. Working: a slow breathing halo. Ready: a clean thin ring. Idle, offline,
 * unknown: progressively quieter.
 */
const RIPPLE_COLOR: Partial<Record<StatusKey, string>> = { needs_you: ATTENTION, error: CORAL, working: STAR, ready: SAGE };

function SessionNode({ n, pulse, selected, hovered, dragging, onEnter, onLeave, onDown, onMove, onUp, onDouble }: SessionNodeProps) {
  const p = PROVIDERS[n.session.provider];
  const { x, y, r } = n;
  const key = statusKey(n.session);
  const missing = n.session.sourceMissing;
  const emphasis = selected ? 1 : hovered ? 0.9 : 0;
  const fill = key === "working" || key === "needs_you" ? 1 : key === "error" || key === "ready" ? 0.86 : key === "idle" ? 0.72 : key === "unknown" ? 0.5 : 0.62;
  return (
    <g
      opacity={dragging ? 0.35 : Math.max(n.opacity, emphasis)}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onDouble();
      }}
      style={{ cursor: "pointer" }}
    >
      {pulse && RIPPLE_COLOR[pulse.to] && (
        <circle key={`ripple-${pulse.at}`} className="ripple" cx={x} cy={y} r={r + 4} fill="none" stroke={RIPPLE_COLOR[pulse.to]} strokeWidth={1} />
      )}
      <g key={pulse?.to === "needs_you" ? `in-${pulse.at}` : "node"} className={pulse?.to === "needs_you" ? "attention-in" : undefined}>
      {key === "needs_you" && (
        <g className={pulse?.to === "needs_you" ? "halo-in" : undefined}>
          <circle cx={x} cy={y} r={r + 14} fill="url(#halo-attention)" />
          <circle cx={x} cy={y} r={r + 4.2} fill="none" stroke={ATTENTION} strokeOpacity={0.9} strokeWidth={1.1} />
        </g>
      )}
      {key === "error" && <circle cx={x} cy={y} r={r + 3.8} fill="none" stroke={CORAL} strokeOpacity={0.85} strokeWidth={1} />}
      {key === "working" && <circle className="breathe" cx={x} cy={y} r={r + 9} fill={`url(#halo-${p.id})`} />}
      {key === "ready" && <circle cx={x} cy={y} r={r + 3.4} fill="none" stroke={SAGE} strokeOpacity={0.55} strokeWidth={0.8} />}
      {selected && <circle cx={x} cy={y} r={r + 6} fill="none" stroke={STAR} strokeOpacity={0.85} strokeWidth={1.1} />}
      {hovered && !selected && <circle cx={x} cy={y} r={r + 5} fill="none" stroke={STAR} strokeOpacity={0.35} strokeWidth={0.8} />}
      <path
        d={glyphPath(p.glyph, x, y, r)}
        fill={missing ? "none" : p.accent}
        fillOpacity={fill}
        stroke={p.accent}
        strokeOpacity={missing ? 0.7 : 1}
        strokeWidth={missing ? 0.9 : 0.6}
        strokeDasharray={missing ? "1.5 1.5" : undefined}
      />
      {key === "working" && <circle cx={x} cy={y} r={Math.max(1.2, r * 0.32)} fill="#fffaf0" />}
      {key === "needs_you" && <circle cx={x} cy={y} r={Math.max(1.1, r * 0.3)} fill="#fff4e0" />}
      </g>
      {n.session.favorite && <path d={sparkle(x + r + 3.5, y - r - 3, 2.6)} fill={STAR} fillOpacity={0.9} />}
      <circle cx={x} cy={y} r={Math.max(11, r + 7)} fill="transparent" />
    </g>
  );
}

/** Focus label meta: why it needs you, or when it was last active. */
function metaText(s: Session): string {
  const key = statusKey(s);
  if (key === "needs_you" || key === "error") return s.runtime.reason ?? (key === "error" ? "Error" : "Needs you");
  if (key === "working") return "working";
  return relativeTime(s.lastActivityAt);
}

function metaColor(s: Session): string {
  const key = statusKey(s);
  return key === "needs_you" ? ATTENTION : key === "error" ? CORAL : key === "working" ? "#b9b3a3" : "#6f747d";
}

/** "2 needs you · 1 error · 2 working", each part in its own state's colour. */
function RuntimeSpans({ counts }: { counts: SystemModel["runtime"] }) {
  const parts = [
    counts.needs_you ? { t: `${counts.needs_you} needs you`, c: ATTENTION } : null,
    counts.error ? { t: `${counts.error} ${counts.error === 1 ? "error" : "errors"}`, c: CORAL } : null,
    counts.working ? { t: `${counts.working} working`, c: "#d8d1bf" } : null,
  ].filter((p): p is { t: string; c: string } => !!p);
  return (
    <>
      {parts.map((p, i) => (
        <tspan key={p.t} fill={p.c}>
          {i > 0 && <tspan fill="#71767f"> · </tspan>}
          {p.t}
        </tspan>
      ))}
    </>
  );
}

function sparkle(x: number, y: number, s: number): string {
  const k = s * 0.28;
  return `M ${x} ${y - s} L ${x + k} ${y - k} L ${x + s} ${y} L ${x + k} ${y + k} L ${x} ${y + s} L ${x - k} ${y + k} L ${x - s} ${y} L ${x - k} ${y - k} Z`;
}

interface CoreProps {
  c: { system: SystemModel; x: number; y: number; alpha: number; scale: number; fade: number };
  focused: boolean;
  t: number;
  hovered: boolean;
  dropTarget: boolean;
  mode: "current" | "all";
  onEnter: () => void;
  onLeave: () => void;
  onClick: () => void;
}

/** "12 current · 32 total" in Current mode when something is hidden; plain count otherwise. */
export function countLabel(system: SystemModel, mode: "current" | "all"): string {
  const { visible, total } = system.counts;
  const noun = (n: number) => (n === 1 ? "session" : "sessions");
  if (mode === "all" || system.expanded || visible === total) return `${total} ${noun(total)}`;
  return `${visible} current · ${total} total`;
}

function ProjectCore({ c, focused, t, hovered, dropTarget, mode, onEnter, onLeave, onClick }: CoreProps) {
  const { system, x, y, alpha, fade } = c;
  const summary = runtimeSummary(system.runtime);
  const unsorted = system.key === UNSORTED;
  const color = system.color ?? STAR;
  const k = focused ? lerp(1, 1.3, t) : 1;
  const coreR = (unsorted ? 6 : 7.5) * k;
  const labelA = focused ? 1 - t : 1;
  const innerZone = ZONES[0][1] * c.scale;
  // A project with nothing current recedes to ~20% but stays where you learned it lives: its
  // core is faint and has no halo; its name stays readable. Hover brings it back up.
  const quiet = !focused && system.visible.length === 0;
  const coreA = quiet ? (hovered ? 0.55 : 0.22) : 1;
  const nameA = quiet ? (hovered ? 0.9 : 0.46) : 1;
  return (
    <g
      opacity={alpha * fade}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      style={{ cursor: "pointer" }}
    >
      <g opacity={coreA}>
      {!quiet && <circle cx={x} cy={y} r={Math.min(52, innerZone * 0.75) * k + (hovered ? 6 : 0)} fill="url(#core-halo)" />}
      {/* The core only breathes for work; what needs you is marked on the session itself. */}
      {system.runtime.working > 0 && <circle className="breathe-core" cx={x} cy={y} r={coreR + 7} fill="none" stroke={STAR} strokeOpacity={0.6} strokeWidth={1} />}
      {dropTarget && <circle cx={x} cy={y} r={coreR + 13} fill="none" stroke={STAR} strokeOpacity={0.8} strokeWidth={1.2} strokeDasharray="3 3" />}
      {unsorted ? (
        <circle cx={x} cy={y} r={coreR} fill="none" stroke={STAR} strokeOpacity={0.4} strokeWidth={1} strokeDasharray="1.6 2.4" />
      ) : (
        <>
          <circle cx={x} cy={y} r={coreR} fill="#0d0e12" stroke={color} strokeOpacity={hovered || focused ? 1 : 0.85} strokeWidth={1.4} />
          <circle cx={x} cy={y} r={coreR * 0.42} fill={color} />
        </>
      )}
      </g>
      <circle cx={x} cy={y} r={26} fill="transparent" />
      {labelA > 0.02 && (
        <g opacity={labelA * nameA} pointerEvents="none">
          <text
            x={x}
            y={y + coreR + 19}
            textAnchor="middle"
            fontSize={unsorted ? 10.5 : 12}
            fontWeight={600}
            letterSpacing="0.14em"
            fill={unsorted ? "#81868f" : "#efede7"}
            className="sky-label"
          >
            {system.name.toUpperCase()}
          </text>
          {summary && (
            <text x={x} y={y + coreR + 34} textAnchor="middle" fontSize={10.5} className="sky-label">
              <RuntimeSpans counts={system.runtime} />
            </text>
          )}
          <text x={x} y={y + coreR + (summary ? 48 : 34)} textAnchor="middle" fontSize={10.5} fill="#71767f" className="sky-label">
            {countLabel(system, mode)}
            {system.isDemo && <tspan> · demo</tspan>}
          </text>
        </g>
      )}
    </g>
  );
}
