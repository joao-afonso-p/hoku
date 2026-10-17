import { useCallback, useEffect, useRef, useState } from "react";
import { closeOverlay, fail, reload } from "../../app/actions";
import { Sheet } from "../../components/Sheet";
import { IconCheck } from "../../components/Icons";
import { api } from "../../lib/api";
import type { VsCodeFlavor, VsCodeSetupResult, VsCodeStatus } from "../../lib/types";
import { installLabel, setupMessage, statusLevel, statusLine, VSCODE_PROMPT_KEY } from "./vscodeExtension";

/**
 * Offers the Hoku extension for VS Code, which tells Hoku which terminals each window has so
 * "Go to terminal" can land on the session itself. Install runs VS Code's own CLI with the
 * VSIX bundled in Hoku; "Allow" sends one ping so VS Code asks its one-time question now.
 * The status re-checks whenever Hoku regains focus.
 */
export function VsCodeExtensionSheet({ step }: { step?: "setup" }) {
  const [statuses, setStatuses] = useState<VsCodeStatus[] | null>(null);
  const check = useCallback(() => void api.vscodeExtensionStatus().then(setStatuses).catch(() => setStatuses([])), []);
  useEffect(() => {
    check();
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, [check]);

  const never = async () => {
    try {
      await api.setSetting(VSCODE_PROMPT_KEY, "never");
      closeOverlay();
      await reload();
    } catch (e) {
      fail(e);
    }
  };

  return (
    <Sheet
      title="Go straight to the right VS Code terminal"
      width={540}
      footer={
        <>
          <button className="btn btn-ghost" onClick={() => void never()}>
            Don’t suggest this again
          </button>
          <button className="btn" onClick={closeOverlay}>
            Not now
          </button>
        </>
      }
    >
      <div className="space-y-4 text-[12.5px] leading-relaxed text-ink-2">
        <p>
          Hoku can bring VS Code forward, but it can’t tell VS Code which window and terminal tab hold a session. The Hoku extension for VS Code tells Hoku which terminals each window has, so Go to
          terminal lands on the session itself.
        </p>
        <ul className="space-y-1.5 text-[12px]">
          <Bullet>Works in every window and project once installed. No setup per project.</Bullet>
          <Bullet>Stays on this Mac: only process numbers and a window number are shared, through a private folder. It never reads terminal contents, file names or workspace paths.</Bullet>
          <Bullet>Not supported: remote windows (SSH, containers, WSL) and VS Code forks.</Bullet>
        </ul>
        {statuses === null && <div className="rounded-[9px] border border-line px-3 py-2.5 text-[12px] text-ink-3">Checking VS Code…</div>}
        {statuses?.length === 0 && <div className="rounded-[9px] border border-line px-3 py-2.5 text-[12px] text-ink-3">VS Code isn’t installed on this Mac.</div>}
        {statuses?.map((s) => <FlavorRow key={s.flavor} s={s} step={step} onChange={check} />)}
      </div>
    </Sheet>
  );
}

function FlavorRow({ s, step, onChange }: { s: VsCodeStatus; step?: "setup"; onChange: () => void }) {
  const [installing, setInstalling] = useState(false);
  const [pinging, setPinging] = useState(false);
  const [result, setResult] = useState<VsCodeSetupResult["status"] | null>(null);
  const allowRef = useRef<HTMLDivElement>(null);
  const label = installLabel(s);
  const installed = s.installedVersion !== null;
  const highlight = step === "setup" && installed;

  useEffect(() => {
    if (highlight) allowRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [highlight]);

  const install = async (flavor: VsCodeFlavor) => {
    setInstalling(true);
    try {
      await api.installVscodeExtension(flavor);
    } catch (e) {
      fail(e);
    } finally {
      setInstalling(false);
      onChange();
    }
  };

  const allow = async (flavor: VsCodeFlavor) => {
    setPinging(true);
    setResult(null);
    try {
      setResult((await api.vscodeSetupPing(flavor)).status);
    } catch (e) {
      fail(e);
    } finally {
      setPinging(false);
      onChange();
    }
  };

  return (
    <div className="rounded-[9px] border border-line px-3 py-2.5 text-[12px]">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium text-ink">{s.name}</div>
          <div className={statusLevel(s) === "connected" ? "flex items-center gap-1.5 text-ok" : "text-ink-3"}>
            {statusLevel(s) === "connected" && <IconCheck size={13} />}
            {statusLine(s)}
          </div>
        </div>
        {label && (
          <button className="btn shrink-0" disabled={!s.bundled || installing} onClick={() => void install(s.flavor)}>
            {installing ? "Installing…" : label}
          </button>
        )}
      </div>
      {label && !s.bundled && <div className="mt-1.5 text-[11.5px] text-ink-4">This build of Hoku doesn’t include the extension.</div>}
      {installed && (
        <div ref={allowRef} className={`mt-2.5 rounded-[8px] px-2.5 py-2 ${highlight ? "border border-line-strong bg-white/[0.03]" : "border border-transparent"}`}>
          <p className="text-ink-3">
            {s.name} will ask once whether to allow the Hoku extension to open a link. Choose <b className="font-medium text-ink">Open</b>, and tick <b className="font-medium text-ink">“Do not ask me again”</b> so it
            doesn’t ask on every click.
          </p>
          <div className="mt-2 flex items-center gap-2.5">
            <button className={highlight ? "btn btn-primary shrink-0" : "btn shrink-0"} disabled={pinging} onClick={() => void allow(s.flavor)}>
              {pinging ? `Waiting for ${s.name}…` : `Allow Hoku in ${s.name}`}
            </button>
            {result && (
              <span className={result === "ready" ? "flex items-center gap-1.5 text-ok" : "text-ink-3"}>
                {result === "ready" && <IconCheck size={13} />}
                {setupMessage(result, s.name)}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-2">
      <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-ink-3" />
      <span>{children}</span>
    </li>
  );
}
