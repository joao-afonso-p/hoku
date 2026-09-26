import { useHub } from "../../app/store";
import { tildify } from "../../lib/paths";
import { relativeTime } from "../../lib/time";
import type { Session } from "../../lib/types";
import { PROVIDERS, surfaceLabel } from "../../providers";
import { GlyphIcon } from "./Glyph";
import { isInferred, reasonText, STATUS, stateSince, statusKey } from "../runtime/status";
import { StatusDot } from "../runtime/StatusMark";

/** Metadata on hover, so the canvas itself stays quiet. */
export function HoverCard({ n, width, height }: { n: { session: Session; x: number; y: number; r: number; system: { name: string } }; width: number; height: number }) {
  const accounts = useHub((s) => s.data.accounts);
  const s = n.session;
  const account = accounts.find((a) => a.id === s.providerAccountId)?.label;
  const p = PROVIDERS[s.provider];
  const W = 280;
  const left = n.x + W + 30 > width ? n.x - W - 18 : n.x + 18;
  const top = Math.min(Math.max(12, n.y + 16), height - 150);
  const where = s.repository ?? s.workingDirectory;

  return (
    <div className="panel fade-in pointer-events-none absolute rounded-[10px] px-3.5 py-3" style={{ left, top, width: W }}>
      <div className="flex items-center gap-1.5 text-[11px]" style={{ color: p.accent }}>
        <GlyphIcon kind={p.glyph} color={p.accent} size={9} />
        <span>{surfaceLabel(s)}</span>
        <span className="text-ink-4">·</span>
        <span className="text-ink-3">{n.system.name}</span>
      </div>
      <div className="mt-1 text-[13px] leading-snug font-medium text-ink">{s.title}</div>
      <RuntimeLine s={s} />
      <div className="mt-1.5 space-y-0.5 text-[11.5px] text-ink-3">
        <div>Last activity {relativeTime(s.lastActivityAt)}</div>
        {account && <div>{account}</div>}
        {where && (
          <div className="truncate font-mono text-[10.5px]">
            {tildify(where)}
            {s.branch && <span className="text-ink-4"> · {s.branch}</span>}
          </div>
        )}
        {s.sourceMissing && <div className="text-danger">No longer on disk</div>}
      </div>
    </div>
  );
}

function RuntimeLine({ s }: { s: Session }) {
  const key = statusKey(s);
  const meta = STATUS[key];
  const loud = key === "needs_you" || key === "error" || key === "working";
  return (
    <div className="mt-2 flex items-start gap-1.5 text-[11.5px]">
      <span className="mt-[1px]">
        <StatusDot status={key} size={7} />
      </span>
      <span className="min-w-0">
        <span style={{ color: loud ? meta.color : undefined }} className={loud ? "" : "text-ink-2"}>
          {meta.label}
        </span>
        <span className="text-ink-3">
          {" "}· {reasonText(s)}
          {stateSince(s) && key !== "offline" && key !== "unknown" && ` · ${relativeTime(stateSince(s))}`}
        </span>
        {s.runtime.detail && <span className="block truncate text-ink-3">{s.runtime.detail}</span>}
        {isInferred(s) && key !== "offline" && <span className="block text-[10.5px] text-ink-4">Inferred · {s.runtime.confidence} confidence</span>}
      </span>
    </div>
  );
}
