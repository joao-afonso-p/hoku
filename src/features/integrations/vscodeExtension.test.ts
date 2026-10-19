import { describe, expect, it } from "vitest";
import type { VsCodeStatus } from "../../lib/types";
import { compareVersions, installLabel, needsFirstUseSetup, readyPromptMarker, setupMessage, setupPromptKey, setupPromptMarker, statusLevel, statusLine, summaryLine, updateAvailable } from "./vscodeExtension";

function status(p: Partial<VsCodeStatus> = {}): VsCodeStatus {
  return {
    flavor: "vscode",
    name: "VS Code",
    appInstalled: true,
    running: 1,
    installedVersion: "0.1.0",
    bundledVersion: "0.1.0",
    bundled: true,
    connectedWindows: 0,
    uriHandledBefore: false,
    ...p,
  };
}

describe("compareVersions", () => {
  it("compares numerically, part by part", () => {
    expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
    expect(compareVersions("0.1", "0.1.0")).toBe(0);
    expect(compareVersions("0.9.1", "0.10.0")).toBe(-1);
    expect(compareVersions("1.0.0", "0.99.99")).toBe(1);
    expect(compareVersions("0.2.0-beta.1", "0.2.0")).toBe(0);
  });
});

describe("statusLine", () => {
  it("says when the extension isn't installed", () => {
    expect(statusLine(status({ installedVersion: null }))).toBe("Setup needed · extension not installed");
    expect(statusLevel(status({ installedVersion: null }))).toBe("missing");
  });

  it("counts connected windows", () => {
    expect(statusLine(status({ connectedWindows: 1, uriHandledBefore: true }))).toBe("Connected to 1 window");
    expect(statusLine(status({ connectedWindows: 3, uriHandledBefore: true }))).toBe("Connected to 3 windows");
    expect(statusLevel(status({ connectedWindows: 3, uriHandledBefore: true }))).toBe("connected");
    expect(statusLine(status({ connectedWindows: 1 }))).toBe("Setup needed · allow the link in VS Code");
  });

  it("asks for a reload when installed but no window reports", () => {
    expect(statusLine(status())).toBe("Setup needed · open or reload VS Code");
    expect(statusLine(status({ name: "VS Code Insiders", flavor: "vscode-insiders" }))).toBe("Setup needed · open or reload VS Code Insiders");
    expect(statusLevel(status())).toBe("installed");
  });

  it("offers an update when the installed version is older", () => {
    const old = status({ installedVersion: "0.0.9", bundledVersion: "0.1.0", connectedWindows: 2 });
    expect(updateAvailable(old)).toBe(true);
    expect(statusLine(old)).toBe("Setup needed · update extension");
    expect(statusLevel(old)).toBe("installed");
    expect(updateAvailable(status({ installedVersion: "0.2.0" }))).toBe(false);
  });
});

describe("installLabel", () => {
  it("installs, updates, or hides", () => {
    expect(installLabel(status({ installedVersion: null }))).toBe("Install in VS Code");
    expect(installLabel(status({ installedVersion: "0.0.1" }))).toBe("Update");
    expect(installLabel(status())).toBeNull();
  });
});

describe("setupMessage", () => {
  it("explains every ping result", () => {
    expect(setupMessage("ready", "VS Code")).toBe("Connected. You can go to your session.");
    expect(setupMessage("no-reply", "VS Code")).toBe("No confirmation. Check VS Code for an Open prompt, then try again.");
    expect(setupMessage("not-running", "VS Code Insiders")).toBe("Open VS Code Insiders first.");
    expect(setupMessage("two-instances", "VS Code")).toBe("More than one VS Code is running, so Hoku can’t tell which one to ask.");
  });
});

describe("summaryLine", () => {
  it("joins one line per build", () => {
    expect(summaryLine([])).toBe("VS Code isn’t installed");
    expect(summaryLine([status({ connectedWindows: 2, uriHandledBefore: true }), status({ flavor: "vscode-insiders", name: "VS Code Insiders", installedVersion: null })])).toBe(
      "VS Code: Connected to 2 windows · VS Code Insiders: Setup needed · extension not installed",
    );
  });
});

describe("first live VS Code open", () => {
  it("offers each incomplete setup once and again after a working extension is removed", () => {
    const missing = status({ installedVersion: null });
    expect(needsFirstUseSetup("vscode", [missing], undefined)).toBe(true);
    expect(needsFirstUseSetup("vscode", [missing], setupPromptMarker(missing))).toBe(false);
    expect(needsFirstUseSetup("vscode", [missing], readyPromptMarker("vscode"))).toBe(true);
    expect(needsFirstUseSetup("vscode", [status({ connectedWindows: 1 })], undefined)).toBe(true);
    expect(needsFirstUseSetup("vscode", [status({ connectedWindows: 1, uriHandledBefore: true })], undefined)).toBe(false);
    expect(needsFirstUseSetup("vscode-insiders", [missing], undefined)).toBe(false);
    expect(needsFirstUseSetup(null, [missing], undefined)).toBe(false);
    expect(needsFirstUseSetup("vscode", [missing], "shown")).toBe(true); // older Hoku builds stored this globally
    expect(needsFirstUseSetup("vscode", [missing], "never")).toBe(false);
    expect(setupPromptKey("vscode")).not.toBe(setupPromptKey("vscode-insiders"));
  });
});
