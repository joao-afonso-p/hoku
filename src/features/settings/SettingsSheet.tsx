import { useEffect, useState } from "react";
import { closeOverlay, fail, reload, setVisibility, toast } from "../../app/actions";
import { useVisibility } from "../../app/model";
import mark from "../../assets/hoku-mark-96.png";
import { RECENT_WINDOWS } from "../galaxy/visibility";
import { AMBIENCE_KEY, ambienceFromSettings, type Ambience } from "../constellation/Starfield";
import { useHub } from "../../app/store";
import { Sheet } from "../../components/Sheet";
import { api } from "../../lib/api";
import { tildify } from "../../lib/paths";
import type { DraftProviderStatus } from "../../lib/types";
import { AI_DRAFTS_KEY } from "../resume/ResumeDrawer";
import { HOW_IT_RUNS, NEVER_SENT, SENT_CATEGORIES } from "../resume/privacy";

const TERMINALS = [
  { id: "auto", label: "Automatic", hint: "iTerm if installed" },
  { id: "iterm", label: "iTerm" },
  { id: "terminal", label: "Terminal" },
];

export function SettingsSheet() {
  const settings = useHub((s) => s.data.settings);
  const demoCount = useHub((s) => s.data.sessions.filter((x) => x.source === "demo").length);
  const [dbPath, setDbPath] = useState<string | null>(null);
  const terminal = (settings.terminal as string) ?? "auto";
  const v = useVisibility();

  useEffect(() => {
    void api.databasePath().then(setDbPath).catch(() => setDbPath(null));
  }, []);

  const ambience = ambienceFromSettings(settings);
  const setAmbience = async (id: Ambience) => {
    try {
      await api.setSetting(AMBIENCE_KEY, id);
      await reload();
    } catch (e) {
      fail(e);
    }
  };

  const setTerminal = async (id: string) => {
    try {
      await api.setSetting("terminal", id);
      await reload();
    } catch (e) {
      fail(e);
    }
  };

  const demo = async (load: boolean) => {
    try {
      await (load ? api.loadDemo() : api.clearDemo());
      await reload();
      toast({ tone: "info", message: load ? "Demo constellations added. They are labelled and can’t be opened." : "Demo data removed" });
    } catch (e) {
      fail(e);
    }
  };

  return (
    <Sheet title="Settings" width={500} footer={<button className="btn btn-primary" onClick={closeOverlay}>Done</button>}>
      <div className="space-y-5">
        <section>
          <div className="eyebrow mb-2">Galaxy visibility</div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-[12.5px] text-ink-2">Recent window</span>
            <div className="flex gap-1 rounded-[8px] border border-line bg-white/[0.02] p-[2px]">
              {RECENT_WINDOWS.map((d) => (
                <button
                  key={d}
                  onClick={() => void setVisibility({ recentWindowDays: d })}
                  className={`h-[22px] rounded-[6px] px-2.5 text-[11.5px] ${v.recentWindowDays === d ? "bg-white/[0.09] text-ink" : "text-ink-3 hover:text-ink-2"}`}
                >
                  {d} days
                </button>
              ))}
            </div>
          </div>
          <Toggle label="Always show live sessions (working, ready, open)" checked={v.alwaysShowActive} onChange={(x) => void setVisibility({ alwaysShowActive: x })} />
          <Toggle label="Always show favorites" checked={v.alwaysShowFavorites} onChange={(x) => void setVisibility({ alwaysShowFavorites: x })} />
          <Toggle label="Hide inactive projects" checked={v.hideInactive} onChange={(x) => void setVisibility({ hideInactive: x })} />
          <div className="mt-2 flex items-center justify-between gap-3">
            <span className="text-[12.5px] text-ink-2">Galaxy ambience</span>
            <div className="flex gap-1 rounded-[8px] border border-line bg-white/[0.02] p-[2px]">
              {(
                [
                  ["still", "Still"],
                  ["subtle", "Subtle motion"],
                ] as [Ambience, string][]
              ).map(([id, label]) => (
                <button
                  key={id}
                  onClick={() => void setAmbience(id)}
                  className={`h-[22px] rounded-[6px] px-2.5 text-[11.5px] ${ambience === id ? "bg-white/[0.09] text-ink" : "text-ink-3 hover:text-ink-2"}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-4">
            Subtle motion lets the background drift imperceptibly and follow the cursor a little; sessions and projects never move. Runtime animations stay on in both modes, and your system’s reduced-motion setting turns motion off. Current shows what you’re working on. All shows every indexed session. Sessions that need you are always shown. Inactive projects stay on the map, very faint, so their place stays familiar; hiding them doesn’t move the others. Search always covers everything.
          </p>
        </section>

        <section>
          <div className="eyebrow mb-2">Claude Code opens in</div>
          <div className="grid grid-cols-3 gap-1 rounded-[9px] border border-line bg-white/[0.02] p-1">
            {TERMINALS.map((t) => (
              <button key={t.id} onClick={() => void setTerminal(t.id)} className={`h-8 rounded-[6px] text-[12.5px] ${terminal === t.id ? "bg-white/[0.08] text-ink" : "text-ink-3 hover:text-ink-2"}`}>
                {t.label}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-4">
            Background sessions are attached with <span className="font-mono">claude attach</span>. Sessions already open in a terminal are brought forward. Everything else resumes with{" "}
            <span className="font-mono">claude --resume</span>. The first time, macOS asks you to allow Hoku to control your terminal.
          </p>
        </section>

        <AiDraftsSection />

        <section>
          <div className="eyebrow mb-2">Privacy</div>
          <ul className="space-y-1 text-[12px] leading-relaxed text-ink-3">
            <li>Everything stays on this Mac. No account, no cloud, no analytics.</li>
            <li>Claude and Codex data is read-only. Their files and databases are never modified.</li>
            <li>No passwords or tokens are read or stored. Sign-in stays with each provider’s app.</li>
            <li>Only titles and a short first-prompt preview are indexed, never full transcripts.</li>
            <li>AI drafts are off unless you turn them on above, and only send when you click Generate draft.</li>
          </ul>
          {dbPath && (
            <div className="mt-2 text-[11.5px] text-ink-4">
              Index stored at <span className="font-mono text-ink-3 select-text">{tildify(dbPath)}</span>
            </div>
          )}
        </section>

        <section>
          <div className="eyebrow mb-2">Demo data</div>
          <div className="flex items-center justify-between gap-3">
            <p className="text-[12px] text-ink-3">{demoCount ? `${demoCount} demo sessions loaded.` : "Add labelled demo constellations to see how dense systems look."}</p>
            {demoCount ? (
              <button className="btn" onClick={() => void demo(false)}>
                Remove demo data
              </button>
            ) : (
              <button className="btn" onClick={() => void demo(true)}>
                Load demo
              </button>
            )}
          </div>
        </section>

        <section>
          <div className="eyebrow mb-2">Keyboard</div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-[12px] text-ink-3">
            {[
              ["⌘ K", "Command palette"],
              ["⌘ N", "Add session"],
              ["⌘ ⇧ S", "Scan for sessions"],
              ["Tab / ⇧ Tab", "Next / previous session"],
              ["↵", "Open selected session"],
              ["⌘ 1–9", "Jump to project"],
              ["Esc", "Back out one level"],
              ["⌘ 0", "Galaxy view"],
              ["R", "Project Resume"],
              ["⌘ ⇧ A", "Current / All"],
            ].map(([k, v]) => (
              <div key={k} className="flex items-center justify-between">
                <span>{v}</span>
                <span className="kbd">{k}</span>
              </div>
            ))}
          </div>
        </section>
        <section className="flex items-center gap-3 border-t border-line pt-4">
          <img src={mark} alt="" className="h-9 w-9" draggable={false} />
          <div>
            <div className="text-[13px] font-semibold text-ink">Hoku</div>
            <div className="text-[11.5px] text-ink-3">Your AI work, mapped. · v0.1.0</div>
          </div>
        </section>
      </div>
    </Sheet>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="mt-2 flex items-center justify-between text-[12.5px] text-ink-2">
      {label}
      <button
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative h-[18px] w-[30px] rounded-full transition-colors ${checked ? "bg-star/80" : "bg-white/[0.1]"}`}
      >
        <span className={`absolute top-[2px] h-[14px] w-[14px] rounded-full bg-void transition-[left] ${checked ? "left-[14px]" : "left-[2px]"}`} />
      </button>
    </label>
  );
}

/**
 * Optional AI drafts for Project Resume. Off by default. Turning it on shows exactly which data
 * categories a draft sends; nothing is sent until Generate draft is clicked in a Resume.
 */
function AiDraftsSection() {
  const enabled = useHub((s) => s.data.settings[AI_DRAFTS_KEY] === "claude-code");
  const [status, setStatus] = useState<DraftProviderStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .aiDraftStatus()
      .then((s) => alive && setStatus(s))
      .catch(() => alive && setStatus(null))
      .finally(() => alive && setChecking(false));
    return () => {
      alive = false;
    };
  }, []);

  const set = async (on: boolean) => {
    try {
      await api.setSetting(AI_DRAFTS_KEY, on ? "claude-code" : "off");
      await reload();
      setConfirming(false);
      toast({ tone: "info", message: on ? "AI drafts on. Nothing is sent until you click Generate draft." : "AI drafts off" });
    } catch (e) {
      fail(e);
    }
  };

  const usable = !!status?.installed && status.supported;
  const cli = checking
    ? "Checking Claude Code…"
    : !status?.installed
      ? "Claude Code CLI not found. Install it to use AI drafts."
      : !status.supported
        ? `Claude Code ${status.version ?? ""} is too old for safe drafts (missing ${status.missingFlags.join(", ")}). Update it to use AI drafts.`
        : `Claude Code ${status.version ?? ""} · ${status.signedIn === true ? "signed in" : status.signedIn === false ? "signed out: run claude auth login in a terminal" : "sign-in status unknown"}`;

  return (
    <section>
      <div className="eyebrow mb-2">AI drafts · optional</div>
      <label className="flex items-center justify-between gap-3 text-[12.5px] text-ink-2">
        <span>Let Claude draft project descriptions in Resume</span>
        <button
          role="switch"
          aria-checked={enabled || confirming}
          disabled={!enabled && !usable}
          onClick={() => (enabled ? void set(false) : setConfirming((c) => !c))}
          className={`relative h-[18px] w-[30px] shrink-0 rounded-full transition-colors disabled:opacity-40 ${enabled ? "bg-star/80" : confirming ? "bg-white/[0.2]" : "bg-white/[0.1]"}`}
        >
          <span className={`absolute top-[2px] h-[14px] w-[14px] rounded-full bg-void transition-[left] ${enabled || confirming ? "left-[14px]" : "left-[2px]"}`} />
        </button>
      </label>
      <p className="mt-1 text-[11.5px] text-ink-3">{cli}</p>
      {(confirming || enabled) && (
        <div className="mt-2 rounded-[9px] border border-line bg-white/[0.02] px-3 py-2.5 text-[12px]">
          <div className="text-ink-2">When you click Generate draft in a project’s Resume, Hoku sends:</div>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 leading-relaxed text-ink-3">
            {SENT_CATEGORIES.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-4">{NEVER_SENT}</p>
          <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-4">{HOW_IT_RUNS} You see the exact text before each draft, and a draft is only saved when you accept it.</p>
          {confirming && !enabled && (
            <div className="mt-2 flex justify-end gap-1.5">
              <button className="btn btn-ghost" onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={() => void set(true)}>
                Turn on AI drafts
              </button>
            </div>
          )}
        </div>
      )}
      {!confirming && !enabled && (
        <p className="mt-1 text-[11.5px] leading-relaxed text-ink-4">Off by default. Resume works fully without it: you write the description and next step yourself.</p>
      )}
    </section>
  );
}
