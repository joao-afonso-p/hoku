import { VSCODE_PROMPT_KEY } from "../features/integrations/vscodeExtension";
import type { OpenResult } from "../lib/types";
import type { Overlay } from "./store";

/** A toast to show after an open. Its action, if any, opens an overlay. */
export interface RoutedToast {
  tone: "info" | "success";
  message: string;
  action?: { label: string; overlay: Overlay };
}

/** What the UI does with an open's result: a toast, an overlay, and a setting to remember. */
export interface OpenRoute {
  toast: RoutedToast | null;
  overlay?: Overlay;
  setSetting?: { key: string; value: string };
}

/** Apps named in "on another desktop" messages, most specific first. */
const SPACES_APPS = ["VS Code Insiders", "VS Code", "Terminal"];

/**
 * Decide what follows "Go to terminal". A hint means the open was an honest partial result
 * (VS Code came forward, but not on the session's own terminal), so it's an info toast; only
 * a result without a hint is a success. The VS Code extension sheet opens by itself once at
 * most; after that the toast offers it, unless the user said not to suggest it again.
 */
export function routeOpenResult(result: OpenResult, settings: Record<string, unknown>): OpenRoute {
  switch (result.hint) {
    case "spaces-setting":
      return { toast: null, overlay: { kind: "spaces-help", app: SPACES_APPS.find((a) => result.message.includes(a)) ?? "iTerm" } };
    case "vscode-extension": {
      const prompt = settings[VSCODE_PROMPT_KEY];
      const toast: RoutedToast = { tone: "info", message: result.message };
      if (prompt === "never") return { toast };
      if (prompt === undefined || prompt === null) {
        return { toast, overlay: { kind: "vscode-extension" }, setSetting: { key: VSCODE_PROMPT_KEY, value: "shown" } };
      }
      return { toast: { ...toast, action: { label: "Set up precise navigation", overlay: { kind: "vscode-extension" } } } };
    }
    case "vscode-setup":
      return {
        toast: { tone: "info", message: result.message, action: { label: "Finish VS Code setup", overlay: { kind: "vscode-extension", step: "setup" } } },
      };
    default:
      return { toast: { tone: "success", message: result.message } };
  }
}
