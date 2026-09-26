import { useEffect, type ReactNode } from "react";
import { closeOverlay } from "../app/actions";

/** Compact modal sheet. Dims the sky rather than hiding it. */
export function Sheet({
  title,
  subtitle,
  width = 460,
  children,
  footer,
  onClose = closeOverlay,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  width?: number;
  children: ReactNode;
  footer?: ReactNode;
  onClose?: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div className="fade-in absolute inset-0 z-40 flex items-start justify-center bg-black/45 pt-[12vh]" onPointerDown={onClose}>
      <div
        className="panel fade-up flex flex-col overflow-hidden rounded-[12px]"
        style={{ width, maxWidth: "calc(100vw - 48px)", maxHeight: "calc(100vh - 12vh - 32px)" }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 px-5 pt-4 pb-3">
          <div className="text-[14px] font-semibold text-ink">{title}</div>
          {subtitle && <div className="mt-0.5 text-[12px] text-ink-3">{subtitle}</div>}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">{children}</div>
        {footer && <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-[11.5px] font-medium text-ink-2">{label}</span>
        {hint && <span className="text-[11px] text-ink-4">{hint}</span>}
      </div>
      {children}
    </label>
  );
}
