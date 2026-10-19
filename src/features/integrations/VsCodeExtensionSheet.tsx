import { useCallback, useEffect, useRef, useState } from "react";
import { closeOverlay, fail, openSession, reload } from "../../app/actions";
import { useHub } from "../../app/store";
import { Sheet } from "../../components/Sheet";
import { IconCheck } from "../../components/Icons";
import { api } from "../../lib/api";
import type { VsCodeFlavor, VsCodeSetupResult, VsCodeStatus } from "../../lib/types";
import { installLabel, readyPromptMarker, setupMessage, setupPromptKey, statusLevel, statusLine, VSCODE_PROMPT_KEY } from "./vscodeExtension";

/**
 * Offers the Hoku extension for VS Code, which tells Hoku which terminals each window has so
 * "Go to terminal" can land on the session itself. Install runs VS Code's own CLI with the
 * VSIX bundled in Hoku; "Allow" sends one ping so VS Code asks its one-time question now.
 * The status re-checks whenever Hoku regains focus.
 */
export function VsCodeExtensionSheet({ step, sessionId, flavor }: { step?: "setup"; sessionId?: string; flavor?: VsCodeFlavor }) {
  const [statuses, setStatuses] = useState<VsCodeStatus[] | null>(null);
  const session = useHub((s) => s.data.sessions.find((item) => item.id === sessionId));
  const check = useCallback(() => void api.vscodeExtensionStatus().then(setStatuses).catch(() => setStatuses([])), []);
  useEffect(() => {
    check();
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, [check]);

  const continueToSession = () => {
    closeOverlay();
    if (session) void openSession(session, true);
  };

  const never = async () => {
    try {
      await api.setSetting(VSCODE_PROMPT_KEY, "never");
      await reload();
      if (sessionId) continueToSession();
      else closeOverlay();
    } catch (e) {
      fail(e);
    }
  };

  return (
    <Sheet
      title={sessionId ? "Open the right VS Code terminal" : "VS Code terminal navigation"}
      width={540}
      footer={
        <>
          <button className="btn btn-ghost" onClick={() => void never()}>
            Don’t suggest this again
          </button>
          <button className="btn" onClick={sessionId ? continueToSession : closeOverlay}>
            {sessionId ? "Continue to VS Code" : "Close"}
          </button>
        </>
      }
    >
      <div className="space-y-3 text-[12.5px] leading-relaxed text-ink-2">
        <p>
          {sessionId
            ? "This session is in VS Code. Install the Hoku extension once to open its exact window and terminal."
            : "Install the Hoku extension once so Go to terminal selects the right VS Code window and terminal."}
        </p>
        <p className="text-[11.5px] text-ink-3">Works across projects. Only process and window numbers stay on this Mac; Hoku never reads terminal text.</p>
        {statuses === null && <div className="rounded-[9px] border border-line px-3 py-2.5 text-[12px] text-ink-3">Checking VS Code…</div>}
        {statuses?.length === 0 && <div className="rounded-[9px] border border-line px-3 py-2.5 text-[12px] text-ink-3">VS Code isn’t installed on this Mac.</div>}
        {statuses?.filter((s) => !flavor || s.flavor === flavor).map((s) => <FlavorRow key={s.flavor} s={s} step={step} onChange={check} />)}
        {sessionId && <p className="text-[11.5px] text-ink-3">You can continue without setup. VS Code will open, but Hoku may not select this terminal.</p>}
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
      const setup = await api.vscodeSetupPing(flavor);
      setResult(setup.status);
      if (setup.status === "ready") await api.setSetting(setupPromptKey(flavor), readyPromptMarker(flavor));
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
          <p className="text-ink-3">Next, allow the Hoku link in {s.name}.</p>
          <div className="mt-2 flex items-center gap-2.5">
            <button className={highlight ? "btn btn-primary shrink-0" : "btn shrink-0"} disabled={pinging} onClick={() => void allow(s.flavor)}>
              {pinging ? "Waiting for approval…" : `Allow link in ${s.name}`}
            </button>
            {result && (
              <span className={result === "ready" ? "flex items-center gap-1.5 text-ok" : "text-ink-3"}>
                {result === "ready" && <IconCheck size={13} />}
                {setupMessage(result, s.name)}
              </span>
            )}
          </div>
          {pinging && <p className="mt-2 text-[12px] text-waiting">Go to your {s.name} window, choose <b>Open</b> in its prompt, then return here.</p>}
        </div>
      )}
    </div>
  );
}
