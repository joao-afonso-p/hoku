import { describe, expect, it } from "vitest";
import type { OpenResult } from "../lib/types";
import { routeOpenResult } from "./openRoute";

function result(hint: OpenResult["hint"], message = "Switched to this session’s terminal in VS Code"): OpenResult {
  return { method: "focus", message, hint };
}

describe("routeOpenResult", () => {
  it("is a success when there is no hint", () => {
    expect(routeOpenResult(result(null), {})).toEqual({ toast: { tone: "success", message: "Switched to this session’s terminal in VS Code" } });
    expect(routeOpenResult(result(undefined), {}).toast?.tone).toBe("success");
  });

  it("keeps the Spaces sheet for the desktop setting", () => {
    expect(routeOpenResult(result("spaces-setting", "The session is in VS Code Insiders on another desktop"), {})).toEqual({
      toast: null,
      overlay: { kind: "spaces-help", app: "VS Code Insiders" },
    });
    expect(routeOpenResult(result("spaces-setting", "The session is in VS Code on another desktop"), {}).overlay).toEqual({ kind: "spaces-help", app: "VS Code" });
    expect(routeOpenResult(result("spaces-setting", "The session is in Terminal on another desktop"), {}).overlay).toEqual({ kind: "spaces-help", app: "Terminal" });
    expect(routeOpenResult(result("spaces-setting", "The session is on another desktop"), {}).overlay).toEqual({ kind: "spaces-help", app: "iTerm" });
  });

  it("opens the extension sheet once, the first time", () => {
    const r = routeOpenResult(result("vscode-extension", "Brought VS Code forward"), {});
    expect(r).toEqual({
      toast: { tone: "info", message: "Brought VS Code forward" },
      overlay: { kind: "vscode-extension" },
      setSetting: { key: "vscodeExtensionPrompt", value: "shown" },
    });
  });

  it("offers the sheet from the toast after that", () => {
    const r = routeOpenResult(result("vscode-extension", "Brought VS Code forward"), { vscodeExtensionPrompt: "shown" });
    expect(r).toEqual({
      toast: { tone: "info", message: "Brought VS Code forward", action: { label: "Set up precise navigation", overlay: { kind: "vscode-extension" } } },
    });
  });

  it("only informs when the user said never", () => {
    const r = routeOpenResult(result("vscode-extension", "Brought VS Code forward"), { vscodeExtensionPrompt: "never" });
    expect(r).toEqual({ toast: { tone: "info", message: "Brought VS Code forward" } });
  });

  it("points to the setup step when VS Code hasn't allowed the extension yet", () => {
    const r = routeOpenResult(result("vscode-setup", "VS Code didn’t answer"), { vscodeExtensionPrompt: "never" });
    expect(r).toEqual({
      toast: { tone: "info", message: "VS Code didn’t answer", action: { label: "Finish VS Code setup", overlay: { kind: "vscode-extension", step: "setup" } } },
    });
  });
});
