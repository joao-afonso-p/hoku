import { describe, expect, it } from "vitest";
import type { VsCodeStatus } from "../../lib/types";
import { compareVersions, installLabel, setupMessage, statusLevel, statusLine, summaryLine, updateAvailable } from "./vscodeExtension";

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
    expect(statusLine(status({ installedVersion: null }))).toBe("Not installed");
    expect(statusLevel(status({ installedVersion: null }))).toBe("missing");
  });

  it("counts connected windows", () => {
    expect(statusLine(status({ connectedWindows: 1 }))).toBe("Connected to 1 window");
    expect(statusLine(status({ connectedWindows: 3 }))).toBe("Connected to 3 windows");
    expect(statusLevel(status({ connectedWindows: 3 }))).toBe("connected");
  });

  it("asks for a reload when installed but no window reports", () => {
    expect(statusLine(status())).toBe("Installed (v0.1.0) — reload open VS Code windows");
    expect(statusLine(status({ name: "VS Code Insiders", flavor: "vscode-insiders" }))).toBe("Installed (v0.1.0) — reload open VS Code Insiders windows");
    expect(statusLevel(status())).toBe("installed");
  });

  it("offers an update when the installed version is older", () => {
    const old = status({ installedVersion: "0.0.9", bundledVersion: "0.1.0", connectedWindows: 2 });
    expect(updateAvailable(old)).toBe(true);
    expect(statusLine(old)).toBe("Update available (v0.0.9 → v0.1.0)");
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
    expect(setupMessage("ready", "VS Code")).toBe("Ready. Go to terminal now goes straight to the session.");
    expect(setupMessage("no-reply", "VS Code")).toBe("VS Code didn’t confirm. If it’s asking, choose Open, then try again.");
    expect(setupMessage("not-running", "VS Code Insiders")).toBe("Open VS Code Insiders first.");
    expect(setupMessage("two-instances", "VS Code")).toBe("More than one VS Code is running, so Hoku can’t tell which one to ask.");
  });
});

describe("summaryLine", () => {
  it("joins one line per build", () => {
    expect(summaryLine([])).toBe("VS Code isn’t installed");
    expect(summaryLine([status({ connectedWindows: 2 }), status({ flavor: "vscode-insiders", name: "VS Code Insiders", installedVersion: null })])).toBe(
      "VS Code: Connected to 2 windows · VS Code Insiders: Not installed",
    );
  });
});
