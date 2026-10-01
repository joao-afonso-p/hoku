/** The webview's OS. Node (Vitest) has no Linux user agent, so tests keep the macOS wording. */
export function isLinuxHost(): boolean {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  return /Linux/i.test(ua) && !/Android/i.test(ua);
}

/** "this Mac" on macOS, "this computer" on Linux. */
export function here(): string {
  return isLinuxHost() ? "this computer" : "this Mac";
}
