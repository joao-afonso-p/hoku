import { tildify } from "../lib/paths";
import type { Provider, Session } from "../lib/types";

export type Glyph = "circle" | "diamond" | "hexagon";

export interface ProviderDescriptor {
  id: Provider;
  /** Short label used on the canvas and in lists. */
  label: string;
  /** Muted accent. Never the only identity cue: glyph shape and label carry it too. */
  accent: string;
  glyph: Glyph;
  /** Fixed canonical order used for angular sectors. */
  order: number;
  /** How a user identifies a session for manual add. */
  referenceLabel: string;
  referencePlaceholder: string;
  needsWorkingDirectory: boolean;
}

export const PROVIDERS: Record<Provider, ProviderDescriptor> = {
  "claude-code": {
    id: "claude-code",
    label: "Claude Code",
    accent: "#e2b27c",
    glyph: "diamond",
    order: 0,
    referenceLabel: "Session ID",
    referencePlaceholder: "4d44b29a-09be-4ffc-… or claude --resume …",
    needsWorkingDirectory: true,
  },
  claude: {
    id: "claude",
    label: "Claude",
    accent: "#dc9a7f",
    glyph: "circle",
    order: 1,
    referenceLabel: "Conversation link or ID",
    referencePlaceholder: "https://claude.ai/chat/… · claude://… · uuid",
    needsWorkingDirectory: false,
  },
  codex: {
    id: "codex",
    label: "Codex",
    accent: "#9fb4ea",
    glyph: "hexagon",
    order: 2,
    referenceLabel: "Thread ID or link",
    referencePlaceholder: "01920a3e-5b7c-… or codex://threads/…",
    needsWorkingDirectory: false,
  },
};

export const PROVIDER_LIST = Object.values(PROVIDERS).sort((a, b) => a.order - b.order);

/** A more specific label where the provider has multiple surfaces. */
export function surfaceLabel(s: Session): string {
  if (s.provider === "claude" && s.metadata?.surface === "cowork") return "Claude Cowork";
  return PROVIDERS[s.provider].label;
}

/**
 * The one way back to a session. For Claude Code it's always "Go to terminal": Hoku decides at
 * click time, from live state, whether that means focusing its tab, attaching to the
 * background session or resuming it (see src-tauri/src/launch.rs).
 */
export function openDescription(s: Session): string {
  if (s.source === "demo") return "Demo session — not connected";
  switch (s.provider) {
    case "claude-code":
      return s.sourceMissing ? "Transcript no longer on disk" : "Go to terminal";
    case "codex":
      return "Open thread in Codex";
    case "claude":
      return s.metadata?.surface === "cowork" ? "Open in Claude Cowork" : "Open conversation in Claude";
  }
}

/**
 * Tooltip detail for "Go to terminal": what will most likely happen, from the latest runtime
 * state. Advisory only — the click re-checks live.
 */
export function openHint(s: Session, terminalPref: string): string | undefined {
  if (s.provider !== "claude-code" || s.source === "demo") return undefined;
  if (s.sourceMissing) return "Claude Code cleaned up this transcript, so it can't be resumed";
  const running = s.runtime.source === "claude-code-registry" && s.runtime.state !== "offline" && s.runtime.state !== "unknown";
  const where = terminalPref === "terminal" ? "Terminal window" : "iTerm tab";
  const live = s.metadata?.live as { kind?: string } | undefined;
  if (running && live?.kind === "bg") return `Will attach to the running background session in a new ${where}`;
  if (running) return "Will switch to the terminal it's running in";
  return `Will resume it in a new ${where}${s.workingDirectory ? ` in ${tildify(s.workingDirectory)}` : ""}`;
}

export const ADAPTER_LABELS: Record<string, string> = {
  "claude-code-transcripts": "Claude Code",
  "codex-state-db": "Codex",
  "claude-cowork": "Claude Cowork",
  "claude-chat": "Claude Chats",
};
