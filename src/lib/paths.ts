let home: string | null = null;

/** Learned from the first absolute path we see under /Users/<name>. */
function homeFrom(path: string): string | null {
  const m = /^\/Users\/[^/]+/.exec(path);
  return m ? m[0] : null;
}

export function tildify(path: string | null | undefined): string {
  if (!path) return "";
  home ??= homeFrom(path);
  return home && path.startsWith(home) ? "~" + path.slice(home.length) : path;
}

export function basename(path: string | null | undefined): string {
  if (!path) return "";
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] ?? path;
}
