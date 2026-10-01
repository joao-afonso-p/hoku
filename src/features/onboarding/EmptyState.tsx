import { useEffect } from "react";
import { loadIntegrations, openOverlay, scan } from "../../app/actions";
import { useHub } from "../../app/store";
import mark from "../../assets/hoku-mark-256.png";
import { here } from "../../lib/host";

/** First run: one sentence, one primary action, and what we can see on this Mac. */
export function EmptyState() {
  const groups = useHub((s) => s.integrations);
  useEffect(() => {
    if (!groups) void loadIntegrations();
  }, [groups]);

  const components = groups?.flatMap((g) => g.components) ?? [];
  const rows = [
    { name: "Claude Desktop", c: components.find((c) => c.id === "claude-desktop") },
    { name: "Claude Code", c: components.find((c) => c.id === "claude-code") },
    { name: "Codex Desktop", c: components.find((c) => c.id === "codex-desktop") },
  ];

  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
      <div className="fade-up pointer-events-auto flex w-[420px] flex-col items-center text-center">
        <img src={mark} alt="" className="h-[88px] w-[88px]" draggable={false} />
        <div className="mt-4 text-[12px] font-semibold tracking-[0.18em] text-ink-3 uppercase">Hoku</div>
        <h1 className="mt-1.5 text-[19px] font-semibold tracking-[-0.01em] text-ink">Your AI work, mapped.</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-3">
          Every Claude and Codex session on {here()}, arranged by project. Find any of them in a second and jump straight back in.
        </p>
        <button className="btn btn-primary mt-6 h-9 px-5 text-[13px]" onClick={() => void scan()}>
          Scan {here()}
        </button>
        <div className="mt-3 flex gap-1 text-[12px]">
          <button className="btn btn-ghost" onClick={() => openOverlay({ kind: "project" })}>
            Create project
          </button>
          <button className="btn btn-ghost" onClick={() => openOverlay({ kind: "add-session" })}>
            Add session manually
          </button>
        </div>
        <div className="mt-8 w-full border-t border-line pt-4">
          {rows.map(({ name, c }) => (
            <div key={name} className="flex items-center justify-between py-1 text-[12px]">
              <span className="text-ink-3">{name}</span>
              <span className={c?.installed ? "text-ink-2" : "text-ink-4"}>
                {!groups ? "Checking…" : c?.installed ? `Detected${c.version ? ` · ${c.version}` : ""}` : "Not found"}
              </span>
            </div>
          ))}
          <div className="mt-2 text-[11px] text-ink-4">Read-only · nothing leaves {here()}</div>
        </div>
      </div>
    </div>
  );
}
