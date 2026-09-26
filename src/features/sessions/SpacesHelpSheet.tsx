import { useEffect, useState } from "react";
import { closeOverlay, fail } from "../../app/actions";
import { Sheet } from "../../components/Sheet";
import { IconCheck } from "../../components/Icons";
import { api } from "../../lib/api";

/**
 * Shown when a session's terminal is on another desktop and Hoku couldn't bring it over.
 * macOS only jumps desktops on activation if a Mission Control setting is on; turning it on
 * fixes this for good. The status re-checks whenever Hoku regains focus.
 */
export function SpacesHelpSheet({ app }: { app: string }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    const check = () => void api.spacesSwitchEnabled().then(setEnabled).catch(() => setEnabled(null));
    check();
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, []);

  return (
    <Sheet
      title={`Your session is in ${app} on another desktop`}
      subtitle="macOS is set not to follow an app to its desktop, so Hoku can’t take you there."
      width={520}
      footer={
        <>
          <button className="btn btn-ghost" onClick={closeOverlay}>
            {enabled ? "Done" : "Not now"}
          </button>
          {!enabled && (
            <button className="btn btn-primary" onClick={() => void api.openSpacesSettings().catch(fail)}>
              Open Desktop &amp; Dock settings
            </button>
          )}
        </>
      }
    >
      <div className="space-y-4 text-[12.5px] leading-relaxed text-ink-2">
        <p>Change one macOS setting once, and “Switch to its terminal” takes you straight to the session, whichever desktop it’s on.</p>
        <ol className="space-y-2.5">
          <Step n={1}>
            Open <b className="font-medium text-ink">System Settings → Desktop &amp; Dock</b> (the button below does this).
          </Step>
          <Step n={2}>
            Scroll down to the <b className="font-medium text-ink">Mission Control</b> section.
          </Step>
          <Step n={3}>
            Turn on <b className="font-medium text-ink">“When switching to an application, switch to a Space with open windows for the application”</b>.
          </Step>
        </ol>
        <div className="rounded-[9px] border border-line px-3 py-2.5 text-[12px]">
          {enabled === null ? (
            <span className="text-ink-3">Checking the setting…</span>
          ) : enabled ? (
            <span className="flex items-center gap-1.5 text-ok">
              <IconCheck size={13} /> The setting is on. Try “Switch to its terminal” again; it will take you there from now on.
            </span>
          ) : (
            <span className="text-ink-3">The setting is currently off. This updates when you come back to Hoku.</span>
          )}
        </div>
        <p className="text-[11.5px] text-ink-4">It’s the macOS default, and it also makes ⌘-Tab jump to an app’s desktop. Hoku doesn’t change it for you.</p>
      </div>
    </Sheet>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <span className="mt-[1px] flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border border-line-strong text-[10.5px] text-ink-3">{n}</span>
      <span>{children}</span>
    </li>
  );
}
