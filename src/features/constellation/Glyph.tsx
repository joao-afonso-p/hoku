import type { Glyph as GlyphKind } from "../../providers";

/** Provider mark: circle (Claude), diamond (Claude Code), hexagon (Codex). */
export function glyphPath(kind: GlyphKind, x: number, y: number, r: number): string {
  switch (kind) {
    case "circle":
      return `M ${x - r} ${y} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0`;
    case "diamond": {
      const d = r * 1.18;
      return `M ${x} ${y - d} L ${x + d} ${y} L ${x} ${y + d} L ${x - d} ${y} Z`;
    }
    case "hexagon": {
      const h = r * 1.08;
      const pts = Array.from({ length: 6 }, (_, i) => {
        const a = (Math.PI / 3) * i + Math.PI / 6;
        return `${(x + Math.cos(a) * h).toFixed(2)} ${(y + Math.sin(a) * h).toFixed(2)}`;
      });
      return `M ${pts.join(" L ")} Z`;
    }
  }
}

/** Standalone inline glyph for HTML contexts (lists, palette, inspector). */
export function GlyphIcon({ kind, color, size = 10, hollow = false }: { kind: GlyphKind; color: string; size?: number; hollow?: boolean }) {
  const r = size * 0.36;
  const c = size / 2;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0" aria-hidden>
      <path
        d={glyphPath(kind, c, c, r)}
        fill={hollow ? "none" : color}
        fillOpacity={hollow ? 0 : 0.9}
        stroke={color}
        strokeWidth={hollow ? 1.1 : 0.8}
      />
    </svg>
  );
}
