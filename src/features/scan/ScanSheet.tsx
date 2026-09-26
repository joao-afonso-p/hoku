import { useEffect, useState } from "react";
import { closeOverlay, fail, reload, toast } from "../../app/actions";
import { useHub } from "../../app/store";
import { Sheet } from "../../components/Sheet";
import { api } from "../../lib/api";
import { tildify } from "../../lib/paths";
import type { ProjectSuggestion, ProviderScanResult } from "../../lib/types";
import { PROVIDERS } from "../../providers";
import { GlyphIcon } from "../constellation/Glyph";

const SCANNING = [
  { provider: "claude-code" as const, label: "Claude Code", what: "reading transcripts in ~/.claude" },
  { provider: "codex" as const, label: "Codex", what: "reading the thread index, read-only" },
  { provider: "claude" as const, label: "Claude Cowork", what: "reading local session metadata" },
];

export function ScanSheet() {
  const scanning = useHub((s) => s.scanning);
  const report = useHub((s) => s.scanReport);

  return (
    <Sheet
      title={scanning ? "Scanning this Mac…" : "Scan complete"}
      subtitle={scanning ? "Everything is read-only. Nothing leaves this Mac." : report ? `Finished ${new Date(report.finishedAt).toLocaleTimeString()}` : undefined}
      width={520}
      footer={
        <button className="btn btn-primary" disabled={scanning} onClick={closeOverlay}>
          Done
        </button>
      }
    >
      {scanning || !report ? (
        <div className="space-y-2.5 py-1">
          {SCANNING.map((s) => (
            <div key={s.label} className="flex items-center gap-3 text-[12.5px]">
              <GlyphIcon kind={PROVIDERS[s.provider].glyph} color={PROVIDERS[s.provider].accent} size={10} />
              <span className="w-28 text-ink-2">{s.label}</span>
              <span className="text-ink-4">{s.what}</span>
            </div>
          ))}
        </div>
      ) : (
        <>
          <div className="divide-y divide-line">
            {report.results.map((r) => (
              <ResultRow key={r.adapter} r={r} />
            ))}
          </div>
          {report.suggestions.length > 0 && <Suggestions suggestions={report.suggestions} />}
        </>
      )}
    </Sheet>
  );
}

function ResultRow({ r }: { r: ProviderScanResult }) {
  const [open, setOpen] = useState(false);
  const p = PROVIDERS[r.provider];
  let summary: React.ReactNode;
  if (r.status === "ok")
    summary = (
      <>
        <span className="text-ink">{r.found} found</span>
        {r.new > 0 && <span className="text-star"> · {r.new} new</span>}
        {r.updated > 0 && <span className="text-ink-3"> · {r.updated} updated</span>}
      </>
    );
  else if (r.status === "manual-only") summary = <span className="text-ink-3">Manual only</span>;
  else if (r.status === "unavailable") summary = <span className="text-ink-3">Not found on this Mac</span>;
  else summary = <span className="text-danger">Couldn’t scan</span>;

  return (
    <div className="py-2.5">
      <div className="flex items-center gap-3 text-[12.5px]">
        <GlyphIcon kind={p.glyph} color={p.accent} size={10} hollow={r.status !== "ok"} />
        <span className="w-52 text-ink-2">{r.label}</span>
        <span className="flex-1">{summary}</span>
        {r.detail && (
          <button className="text-[11px] text-ink-4 hover:text-ink-2" onClick={() => setOpen((o) => !o)}>
            {open ? "Hide" : "Details"}
          </button>
        )}
      </div>
      {r.message && r.status !== "ok" && <div className="mt-1 pl-[26px] text-[11.5px] text-ink-3">{r.message}</div>}
      {open && r.detail && <div className="mt-1 pl-[26px] font-mono text-[11px] break-all text-ink-4 select-text">{r.detail}</div>}
    </div>
  );
}

function Suggestions({ suggestions }: { suggestions: ProjectSuggestion[] }) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set(suggestions.filter((s) => s.sessionCount >= 2).map((s) => s.rootPath)));
  const [names, setNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => setPicked(new Set(suggestions.filter((s) => s.sessionCount >= 2).map((s) => s.rootPath))), [suggestions]);

  const toggle = (root: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(root)) n.delete(root);
      else n.add(root);
      return n;
    });

  const create = async () => {
    setBusy(true);
    try {
      const chosen = suggestions.filter((s) => picked.has(s.rootPath)).map((s) => ({ name: names[s.rootPath]?.trim() || s.name, rootPath: s.rootPath, color: s.color }));
      const moved = await api.createProjectsFromSuggestions(chosen);
      await reload();
      toast({ tone: "success", message: `Created ${chosen.length} projects · ${moved} sessions placed` });
      closeOverlay();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 border-t border-line pt-3.5">
      <div className="flex items-baseline justify-between">
        <div className="eyebrow">Suggested projects</div>
        <div className="text-[11px] text-ink-4">from working directories and Codex projects</div>
      </div>
      <div className="mt-2 max-h-[240px] space-y-0.5 overflow-y-auto">
        {suggestions.map((s) => (
          <label key={s.rootPath} className="flex items-center gap-3 rounded-[7px] px-1.5 py-1.5 hover:bg-white/[0.03]">
            <input type="checkbox" className="accent-[#f1ead8]" checked={picked.has(s.rootPath)} onChange={() => toggle(s.rootPath)} />
            <input
              className="w-40 rounded bg-transparent text-[12.5px] text-ink outline-none focus:bg-white/[0.04]"
              value={names[s.rootPath] ?? s.name}
              onChange={(e) => setNames((n) => ({ ...n, [s.rootPath]: e.target.value }))}
            />
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-4">{tildify(s.rootPath)}</span>
            <span className="text-[11.5px] text-ink-3">{s.sessionCount}</span>
          </label>
        ))}
      </div>
      <div className="mt-3 flex justify-end">
        <button className="btn" disabled={picked.size === 0 || busy} onClick={() => void create()}>
          Create {picked.size} {picked.size === 1 ? "project" : "projects"}
        </button>
      </div>
    </div>
  );
}
