import type { VsCodeSetupResult, VsCodeStatus } from "../../lib/types";

/** Settings key: whether Hoku may suggest the VS Code extension ("shown" once, or "never"). */
export const VSCODE_PROMPT_KEY = "vscodeExtensionPrompt";

/** Compare dotted versions numerically ("0.10.0" > "0.9.1"). Pre-release tags are ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split(/[-+]/)[0].split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

/** The installed extension is older than the one this Hoku carries. */
export function updateAvailable(s: VsCodeStatus): boolean {
  return s.installedVersion !== null && compareVersions(s.installedVersion, s.bundledVersion) < 0;
}

export function windowsLabel(n: number): string {
  return `${n} window${n === 1 ? "" : "s"}`;
}

/** One line per VS Code build: what the extension is doing there. */
export function statusLine(s: VsCodeStatus): string {
  if (s.installedVersion === null) return "Not installed";
  if (updateAvailable(s)) return `Update available (v${s.installedVersion} → v${s.bundledVersion})`;
  if (s.connectedWindows > 0) return `Connected to ${windowsLabel(s.connectedWindows)}`;
  return `Installed (v${s.installedVersion}) — reload open ${s.name} windows`;
}

/** "connected" when windows report, "installed" when it's there but quiet, else "missing". */
export function statusLevel(s: VsCodeStatus): "connected" | "installed" | "missing" {
  if (s.installedVersion === null) return "missing";
  return s.connectedWindows > 0 && !updateAvailable(s) ? "connected" : "installed";
}

/** The install button's label, or null when the installed extension is current. */
export function installLabel(s: VsCodeStatus): string | null {
  if (s.installedVersion === null) return `Install in ${s.name}`;
  return updateAvailable(s) ? "Update" : null;
}

/** What the setup ping's answer means for the user. */
export function setupMessage(status: VsCodeSetupResult["status"], name: string): string {
  switch (status) {
    case "ready":
      return "Connected: VS Code let the Hoku extension open the link. If it asks again on Go to terminal, choose Open and tick “Do not ask me again”.";
    case "no-reply":
      return `${name} didn’t confirm. If it’s asking, choose Open, then try again.`;
    case "not-running":
      return `Open ${name} first.`;
    case "two-instances":
      return `More than one ${name} is running, so Hoku can’t tell which one to ask.`;
  }
}

/** The compact summary for the Integrations row: "VS Code: Connected to 2 windows · …". */
export function summaryLine(statuses: VsCodeStatus[]): string {
  if (statuses.length === 0) return "VS Code isn’t installed";
  return statuses.map((s) => `${s.name}: ${statusLine(s)}`).join(" · ");
}
