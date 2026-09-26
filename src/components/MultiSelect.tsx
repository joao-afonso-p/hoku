import { useEffect, useRef, useState, type ReactNode } from "react";
import { IconCheck, IconChevronDown } from "./Icons";

export interface MultiOption<K extends string> {
  key: K;
  label: string;
  count?: number;
  mark?: ReactNode;
}

/** Compact multi-select popover: "Status ▾". Stays open while toggling. */
export function MultiSelect<K extends string>({
  label,
  options,
  selected,
  onToggle,
  onClear,
  align = "left",
  width = 208,
}: {
  label: ReactNode;
  options: MultiOption<K>[];
  selected: K[];
  onToggle: (k: K) => void;
  onClear?: () => void;
  align?: "left" | "right";
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [open]);

  const active = selected.length > 0;
  return (
    <div ref={ref} className="relative" onPointerDown={(e) => e.stopPropagation()}>
      <button
        className={`flex h-[26px] items-center gap-1 rounded-[7px] border px-2 text-[11.5px] whitespace-nowrap transition-colors ${
          active ? "border-line-strong bg-white/[0.06] text-ink" : "border-line bg-white/[0.02] text-ink-3 hover:text-ink-2"
        }`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        {label}
        {active && <span className="text-ink-3">· {selected.length}</span>}
        <IconChevronDown size={12} className="text-ink-4" />
      </button>
      {open && (
        <div className={`panel fade-in absolute top-[30px] z-50 rounded-[10px] py-1 ${align === "right" ? "right-0" : "left-0"}`} style={{ width }}>
          {options.map((o) => {
            const on = selected.includes(o.key);
            return (
              <button key={o.key} className="flex w-full items-center gap-2 px-2.5 py-[5px] text-left text-[12px] hover:bg-white/[0.05]" onClick={() => onToggle(o.key)}>
                <span className={`flex h-3.5 w-3.5 items-center justify-center rounded-[4px] border ${on ? "border-star/60 bg-star/15 text-star" : "border-line-strong text-transparent"}`}>
                  <IconCheck size={10} />
                </span>
                {o.mark && <span className="flex w-4 justify-center">{o.mark}</span>}
                <span className={`flex-1 truncate ${on ? "text-ink" : "text-ink-2"}`}>{o.label}</span>
                {o.count !== undefined && <span className="text-[11px] text-ink-4 tabular-nums">{o.count}</span>}
              </button>
            );
          })}
          {onClear && active && (
            <button className="mt-1 w-full border-t border-line px-2.5 pt-1.5 pb-1 text-left text-[11.5px] text-ink-3 hover:text-ink-2" onClick={onClear}>
              Clear
            </button>
          )}
        </div>
      )}
    </div>
  );
}
