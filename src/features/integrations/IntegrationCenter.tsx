import { useEffect, useState } from "react";
import { closeOverlay, fail, loadIntegrations, reload, scan } from "../../app/actions";
import { useHub } from "../../app/store";
import { api } from "../../lib/api";
import { relativeTime } from "../../lib/time";
import type { IntegrationCapability, ProviderAccount, ProviderGroup, RuntimeCapabilities, SupportLevel } from "../../lib/types";
import { IconClose } from "../../components/Icons";

const STAR = "#f1ead8";

const DISCOVERY_LABEL: Record<IntegrationCapability["discovery"], string> = {
  "indexed-read-only": "Indexed · read-only",
  "manual-only": "Manual only",
  unavailable: "Discovery unavailable",
};
const OPEN_LABEL: Record<IntegrationCapability["open"], string> = {
  direct: "Opens directly",
  fallback: "Fallback open",
  unavailable: "Direct open unavailable",
};
const LIVE_LABEL: Record<RuntimeCapabilities["liveStatus"], string> = {
  full: "Full",
  partial: "Partial",
  limited: "Limited",
  none: "Not available",
};

/** ✓ full · ◐ partial (inferred) · — none. Limitations are shown, not hidden. */
function Level({ level, label }: { level: SupportLevel; label: string }) {
  const mark = level === "full" ? "✓" : level === "partial" ? "◐" : "—";
  return (
    <span className={level === "none" ? "text-ink-4" : "text-ink-2"} title={level === "partial" ? `${label}: inferred, not reported directly` : level === "none" ? `${label}: not detectable` : label}>
      <span className={level === "full" ? "text-star" : level === "partial" ? "text-waiting" : ""}>{mark}</span> {label}
    </span>
  );
}

export function IntegrationCenter() {
  const groups = useHub((s) => s.integrations);
  const [checking, setChecking] = useState(false);

  const check = async () => {
    setChecking(true);
    await loadIntegrations();
    setChecking(false);
  };
  useEffect(() => {
    void check();
  }, []);

  return (
    <div className="fade-in absolute inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/55 py-[7vh]" onPointerDown={closeOverlay}>
      <div className="panel fade-up w-[820px] max-w-[calc(100vw-48px)] rounded-[14px]" onPointerDown={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between px-6 pt-5">
          <div>
            <div className="text-[15px] font-semibold text-ink">Integrations</div>
            <div className="mt-0.5 max-w-[560px] text-[12px] leading-relaxed text-ink-3">
              Sign-in is handled by each provider’s own app. Hoku never asks for or stores passwords. It reads local metadata read-only and hands you back to the native tool.
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button className="btn" disabled={checking} onClick={() => void check()}>
              {checking ? "Checking…" : "Check again"}
            </button>
            <button className="btn btn-ghost h-7 w-7 justify-center px-0 text-ink-3" onClick={closeOverlay} aria-label="Close">
              <IconClose size={14} />
            </button>
          </div>
        </div>
        <div className="space-y-3 p-6 pt-5">
          {!groups && <div className="py-10 text-center text-[12.5px] text-ink-3">Checking apps, command-line tools and sign-in state…</div>}
          {groups?.map((g) => <ProviderSystem key={g.id} g={g} />)}
        </div>
      </div>
    </div>
  );
}

function statusColor(ok: boolean | "partial") {
  return ok === true ? STAR : ok === "partial" ? "#d8c08a" : "#4b4f57";
}

function ProviderSystem({ g }: { g: ProviderGroup }) {
  const sessions = useHub((s) => s.data.sessions);
  const lastScans = useHub((s) => s.data.lastScans);
  const [manage, setManage] = useState(false);
  const adapters = g.capabilities.map((c) => c.adapter);
  const indexed = sessions.filter((s) => (g.id === "codex" ? s.provider === "codex" : s.provider !== "codex") && s.source !== "demo").length;
  const scans = lastScans.filter((s) => adapters.includes(s.adapter));
  const last = scans.map((s) => s.finishedAt).sort().pop();
  const accountOk = g.account.status === "connected" ? true : g.account.status === "unknown" ? "partial" : false;

  // Satellites: account + components, drawn as a small orbital system.
  const sats = [
    { label: "Account", ok: accountOk as boolean | "partial" },
    ...g.components.map((c) => ({ label: c.name.replace(/^Claude |^Codex /, ""), ok: (c.installed ? true : c.bundledPath ? "partial" : false) as boolean | "partial" })),
  ];

  return (
    <section className="grid grid-cols-[210px_1fr] gap-6 rounded-[12px] border border-line bg-white/[0.015] p-5">
      <svg width={210} height={170} viewBox="0 0 210 170" className="overflow-visible">
        <circle cx={105} cy={82} r={58} fill="none" stroke={STAR} strokeOpacity={0.07} strokeDasharray="1 4" />
        {sats.map((s, i) => {
          const a = -Math.PI / 2 + (i * 2 * Math.PI) / sats.length + 0.35;
          const x = 105 + Math.cos(a) * 58;
          const y = 82 + Math.sin(a) * 58;
          const c = statusColor(s.ok);
          return (
            <g key={s.label}>
              <line x1={105} y1={82} x2={x} y2={y} stroke={STAR} strokeOpacity={s.ok ? 0.14 : 0.05} />
              <circle cx={x} cy={y} r={4.2} fill={s.ok === true ? c : "none"} stroke={c} strokeWidth={1.1} />
              <text x={x} y={y + (Math.sin(a) > 0.2 ? 17 : -10)} textAnchor="middle" fontSize={10.5} fill={s.ok ? "#a9adb5" : "#5a5f67"} className="sky-label">
                {s.label}
              </text>
            </g>
          );
        })}
        <circle cx={105} cy={82} r={22} fill="url(#ic-halo)" />
        <defs>
          <radialGradient id="ic-halo">
            <stop offset="0%" stopColor={STAR} stopOpacity={0.14} />
            <stop offset="100%" stopColor={STAR} stopOpacity={0} />
          </radialGradient>
        </defs>
        <circle cx={105} cy={82} r={7} fill="#0d0e12" stroke={STAR} strokeWidth={1.2} />
        <circle cx={105} cy={82} r={2.8} fill={STAR} />
        <text x={105} y={162} textAnchor="middle" fontSize={11} fontWeight={600} letterSpacing="0.16em" fill="#eceae4" className="sky-label">
          {g.name.toUpperCase()}
        </text>
      </svg>

      <div className="min-w-0 overflow-hidden">
        <dl className="text-[12.5px]">
          <StatusRow label="Account" ok={accountOk} value={g.account.label} sub={[g.account.detail, g.account.managedBy].filter(Boolean).join(" · ")} />
          {g.components.map((c) => (
            <StatusRow
              key={c.id}
              label={c.name}
              ok={c.installed ? true : c.bundledPath ? "partial" : false}
              value={
                c.installed
                  ? `Installed${c.version ? ` · ${c.version}` : ""}${c.running ? " · running" : ""}`
                  : c.bundledPath
                    ? `Not on PATH · bundled with ${g.name} Desktop`
                    : "Not installed"
              }
              sub={c.path ?? c.bundledPath ?? undefined}
              mono
            />
          ))}
          <StatusRow label="Indexed sessions" ok={indexed > 0 ? true : "partial"} value={String(indexed)} sub={last ? `Last scan ${relativeTime(last)}` : "Not scanned yet"} />
        </dl>

        <div className="mt-3 grid gap-2.5">
          {g.capabilities.map((c) => (
            <div key={c.adapter} className="grid grid-cols-[150px_1fr] gap-3 text-[11.5px]">
              <span className="text-ink-2">{c.label}</span>
              <span className="min-w-0">
                <span className={c.discovery === "indexed-read-only" ? "text-ink-2" : "text-ink-3"}>{DISCOVERY_LABEL[c.discovery]}</span>
                <span className="text-ink-4"> · </span>
                <span className={c.open === "direct" ? "text-ink-2" : "text-ink-3"}>{OPEN_LABEL[c.open]}</span>
                <span className="block truncate text-ink-4" title={c.detail}>
                  {c.detail}
                </span>
                <span className="mt-0.5 flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
                  <span className={c.runtime.liveStatus === "none" ? "text-ink-3" : "text-ink-2"}>Live state: {LIVE_LABEL[c.runtime.liveStatus]}</span>
                  {c.runtime.liveStatus !== "none" && (
                    <>
                      <Level level={c.runtime.working} label="Working" />
                      <Level level={c.runtime.needsInput} label="Needs input" />
                      <Level level={c.runtime.ready} label="Ready" />
                      <Level level={c.runtime.error} label="Errors" />
                    </>
                  )}
                </span>
                <span className="block truncate text-ink-4" title={c.runtime.detail}>
                  {c.runtime.detail}
                </span>
              </span>
            </div>
          ))}
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <button className="btn" onClick={() => void api.openProviderApp(g.id).catch(fail)} disabled={!g.components.find((c) => c.kind === "app")?.installed}>
            Open {g.name}
          </button>
          <button className="btn" onClick={() => void scan(adapters.filter((a) => a !== "claude-chat"))}>
            Scan sessions
          </button>
          <button className="btn btn-ghost" onClick={() => setManage((m) => !m)}>
            {manage ? "Done" : "Manage accounts"}
          </button>
        </div>
        {manage && <Accounts provider={g.id} />}
      </div>
    </section>
  );
}

function StatusRow({ label, ok, value, sub, mono }: { label: string; ok: boolean | "partial"; value: string; sub?: string; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[150px_1fr] items-baseline gap-3 py-1">
      <dt className="flex items-center gap-2 text-ink-3">
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: ok === true ? STAR : "transparent", border: `1px solid ${statusColor(ok)}` }} />
        {label}
      </dt>
      <dd className="min-w-0">
        <span className="text-ink">{value}</span>
        {sub && <span className={`block truncate text-[11px] text-ink-4 ${mono ? "font-mono" : ""}`}>{sub}</span>}
      </dd>
    </div>
  );
}

function Accounts({ provider }: { provider: "claude" | "codex" }) {
  const accounts = useHub((s) => s.data.accounts.filter((a) => a.provider === provider));
  const [label, setLabel] = useState("");
  const add = async () => {
    if (!label.trim()) return;
    try {
      await api.createAccount(provider, label.trim());
      setLabel("");
      await reload();
    } catch (e) {
      fail(e);
    }
  };
  return (
    <div className="mt-3 rounded-[9px] border border-line p-3">
      <div className="eyebrow mb-2">Accounts</div>
      <div className="mb-2 text-[11.5px] leading-relaxed text-ink-3">
        Labels for organising sessions (e.g. Personal, Work). Sign-in stays with the provider app. Nothing is stored here but the label.
      </div>
      {accounts.map((a) => (
        <AccountRow key={a.id} a={a} />
      ))}
      <div className="mt-2 flex gap-2">
        <input className="field h-7 py-0 text-[12px]" placeholder="Add account label, e.g. Personal" value={label} onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void add()} />
        <button className="btn" onClick={() => void add()} disabled={!label.trim()}>
          Add
        </button>
      </div>
    </div>
  );
}

function AccountRow({ a }: { a: ProviderAccount }) {
  const count = useHub((s) => s.data.sessions.filter((x) => x.providerAccountId === a.id).length);
  const [label, setLabel] = useState(a.label);
  return (
    <div className="flex items-center gap-2 py-1">
      <input
        className="rounded bg-transparent px-1 text-[12.5px] text-ink outline-none focus:bg-white/[0.05]"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onBlur={() => label.trim() && label !== a.label && void api.renameAccount(a.id, label).then(reload).catch(fail)}
      />
      <span className="text-[11px] text-ink-4">
        {count} sessions · {a.authMode === "external-app" ? "managed by provider app" : a.authMode}
      </span>
    </div>
  );
}
