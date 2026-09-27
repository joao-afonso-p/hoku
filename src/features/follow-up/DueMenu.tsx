import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { followUp } from "../../app/actions";
import type { Session } from "../../lib/types";
import { clockTime, dayName, fromLocalInput, snoozePresets, toLocalInput } from "./followUp";

const WIDTH = 232;

/**
 * "Remind me": snooze presets, a date picker and "No date". Adds the session to Follow up if
 * it isn't there yet. Portalled and positioned against the viewport, so neither a scrolling
 * list nor an animated panel (a transform makes it the containing block) can misplace it.
 */
export function DueMenu({ session, className, title, children }: { session: Session; className: string; title?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const r = trigger.current.getBoundingClientRect();
    const height = menu.current?.offsetHeight ?? 200;
    const top = r.bottom + 4 + height > window.innerHeight - 8 ? Math.max(8, r.top - 4 - height) : r.bottom + 4;
    setPos({ top, left: Math.min(Math.max(8, r.right - WIDTH), window.innerWidth - WIDTH - 8) });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>("button")?.focus();
    const down = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [open]);

  const choose = (at: number | null) => {
    setOpen(false);
    void followUp(session, at === null ? null : new Date(at).toISOString());
  };

  return (
    <>
      <button
        ref={trigger}
        className={className}
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {children}
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            role="menu"
            className="panel fade-in fixed z-[60] rounded-[10px] py-1"
            style={{ width: WIDTH, top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <MenuBody session={session} onChoose={choose} />
          </div>,
          document.body,
        )}
    </>
  );
}

function MenuBody({ session, onChoose }: { session: Session; onChoose: (at: number | null) => void }) {
  const now = Date.now();
  const current = session.followUp?.dueAt ? Date.parse(session.followUp.dueAt) : null;
  const [custom, setCustom] = useState(() => toLocalInput(current && current > now ? current : snoozePresets(now)[1].at));
  const picked = fromLocalInput(custom);
  const item = "flex w-full items-center gap-2 px-2.5 py-[5px] text-left text-[12px] text-ink-2 hover:bg-white/[0.05] hover:text-ink focus-visible:bg-white/[0.05] focus-visible:outline-none";

  return (
    <>
      <div className="eyebrow px-2.5 pt-1 pb-1">{session.followUp ? "Remind me" : "Follow up"}</div>
      {snoozePresets(now).map((p) => (
        <button key={p.id} role="menuitem" className={item} onClick={() => onChoose(p.at)}>
          <span className="flex-1">{p.label}</span>
          <span className="text-[11px] text-ink-4 tabular-nums">
            {p.id === "next-week" ? `${dayName(p.at, now)} ` : ""}
            {clockTime(p.at)}
          </span>
        </button>
      ))}
      <form
        className="flex items-center gap-1.5 px-2.5 py-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (picked !== null) onChoose(picked);
        }}
      >
        <input
          type="datetime-local"
          aria-label="Pick a date and time"
          className="field h-7 min-w-0 flex-1 px-1.5 py-0 text-[11.5px] [color-scheme:dark]"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
        />
        <button className="btn h-7 px-2 text-[11.5px]" disabled={picked === null}>
          Set
        </button>
      </form>
      {(!session.followUp || session.followUp.dueAt) && (
        <button role="menuitem" className={`${item} border-t border-line`} onClick={() => onChoose(null)}>
          <span className="flex-1">{session.followUp ? "Remove reminder" : "No date, just later"}</span>
        </button>
      )}
    </>
  );
}
