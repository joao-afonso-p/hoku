let home: string | null = null;

/** Learned from the first absolute path under /Users/<name> or /home/<name>. */
function homeFrom(path: string): string | null {
  const mac = /^\/Users\/[^/]+/.exec(path);
  if (mac) return mac[0];
  const linux = /^\/home\/[^/]+/.exec(path);
  return linux ? linux[0] : null;
}

export function tildify(path: string | null | undefined): string {
  if (!path) return "";
  const found = homeFrom(path);
  if (found) home = found;
  const root = found ?? home;
  return root && path.startsWith(root) ? "~" + path.slice(root.length) : path;
}

export function basename(path: string | null | undefined): string {
  if (!path) return "";
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] ?? path;
}
