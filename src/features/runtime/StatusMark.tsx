import type { Session } from "../../lib/types";
import { isInferred, reasonText, STATUS, statusKey, type StatusKey } from "./status";

/**
 * Small status glyph for HTML contexts. Communicates by shape and luminance first, colour
 * second: filled = something is happening or waiting, ring = settled, dotted = unknown.
 */
export function StatusDot({ status, size = 8 }: { status: StatusKey; size?: number }) {
  const c = STATUS[status].color;
  const r = size / 2;
  const common = { width: size + 6, height: size + 6, viewBox: `${-r - 3} ${-r - 3} ${size + 6} ${size + 6}`, className: "shrink-0 overflow-visible", "aria-hidden": true } as const;
  switch (status) {
    case "needs_you":
      return (
        <svg {...common}>
          <circle r={r + 2.6} fill={c} fillOpacity={0.16} />
          <circle r={r * 0.78} fill={c} />
        </svg>
      );
    case "error":
      return (
        <svg {...common}>
          <circle r={r * 0.9} fill="none" stroke={c} strokeWidth={1.2} />
          <circle r={r * 0.34} fill={c} />
        </svg>
      );
    case "working":
      return (
        <svg {...common}>
          <circle className="breathe" r={r + 2.2} fill={c} fillOpacity={0.3} />
          <circle r={r * 0.62} fill={c} />
        </svg>
      );
    case "ready":
      return (
        <svg {...common}>
          <circle r={r * 0.82} fill="none" stroke={c} strokeWidth={1.1} />
          <circle r={r * 0.3} fill={c} fillOpacity={0.9} />
        </svg>
      );
    case "idle":
      return (
        <svg {...common}>
          <circle r={r * 0.62} fill="none" stroke={c} strokeWidth={1.1} />
        </svg>
      );
    case "offline":
      return (
        <svg {...common}>
          <circle r={r * 0.5} fill={c} fillOpacity={0.7} />
        </svg>
      );
    case "unknown":
      return (
        <svg {...common}>
          <circle r={r * 0.7} fill="none" stroke={c} strokeWidth={1} strokeDasharray="1.2 1.6" />
        </svg>
      );
  }
}

/** "Needs You · Waiting for permission" as a quiet micro-label. */
export function StatusLabel({ session, withReason = true, className = "" }: { session: Session; withReason?: boolean; className?: string }) {
  const key = statusKey(session);
  const meta = STATUS[key];
  const strong = key === "needs_you" || key === "error" || key === "working";
  return (
    <span className={`inline-flex min-w-0 items-center gap-1 ${className}`} title={`${meta.label} · ${session.runtime.confidence} confidence${session.runtime.source ? ` · ${session.runtime.source}` : ""}`}>
      <span style={{ color: strong ? meta.color : undefined }} className={strong ? "" : "text-ink-3"}>
        {meta.label}
      </span>
      {withReason && session.runtime.reason && (
        <span className="truncate text-ink-3">
          <span className="text-ink-4">·</span> {reasonText(session)}
        </span>
      )}
      {isInferred(session) && key !== "offline" && key !== "unknown" && <span className="text-ink-4">· inferred</span>}
    </span>
  );
}

/** "1 needs you · 2 working" with each part in its state's colour. Renders nothing when quiet. */
export function RuntimeSummaryText({ counts }: { counts: Pick<Record<StatusKey, number>, "needs_you" | "error" | "working"> }) {
  const parts = [
    counts.needs_you ? { t: `${counts.needs_you} needs you`, c: STATUS.needs_you.color } : null,
    counts.error ? { t: `${counts.error} ${counts.error === 1 ? "error" : "errors"}`, c: STATUS.error.color } : null,
    counts.working ? { t: `${counts.working} working`, c: "#d8d1bf" } : null,
  ].filter((p): p is { t: string; c: string } => !!p);
  if (!parts.length) return null;
  return (
    <span>
      {parts.map((p, i) => (
        <span key={p.t}>
          {i > 0 && <span className="text-ink-4"> · </span>}
          <span style={{ color: p.c }}>{p.t}</span>
        </span>
      ))}
    </span>
  );
}
