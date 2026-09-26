import { useState } from "react";
import { dismissToast } from "../app/actions";
import { useHub } from "../app/store";
import type { Toast } from "../app/store";

export function Toasts() {
  const toasts = useHub((s) => s.toasts);
  return (
    <div className="pointer-events-none absolute bottom-5 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((t) => (
        <ToastItem key={t.id} t={t} />
      ))}
    </div>
  );
}

function ToastItem({ t }: { t: Toast }) {
  const [open, setOpen] = useState(false);
  const dot = t.tone === "error" ? "bg-danger" : t.tone === "success" ? "bg-star" : "bg-ink-3";
  return (
    <div className="panel fade-up pointer-events-auto max-w-[520px] rounded-[10px] px-3.5 py-2.5 text-[12.5px]">
      <div className="flex items-start gap-2.5">
        <span className={`mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
        <div className="min-w-0 flex-1">
          <div className="text-ink">{t.message}</div>
          {t.detail && open && <div className="mt-1.5 font-mono text-[11px] break-all text-ink-3 select-text">{t.detail}</div>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {t.action && (
            <button
              className="btn h-6 px-2 text-[11.5px]"
              onClick={() => {
                t.action!.run();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          {t.detail && (
            <button className="btn btn-ghost h-6 px-2 text-[11.5px] text-ink-3" onClick={() => setOpen((o) => !o)}>
              {open ? "Hide" : "Details"}
            </button>
          )}
          <button className="btn btn-ghost h-6 w-6 justify-center px-0 text-ink-4" onClick={() => dismissToast(t.id)} aria-label="Dismiss">
            ×
          </button>
        </div>
      </div>
    </div>
  );
}
