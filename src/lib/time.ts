const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function ageMs(iso: string | null | undefined, now = Date.now()): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : Math.max(0, now - t);
}

/** "now", "8m", "3h", "yesterday", "5d", "Sep 2" */
export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  const a = ageMs(iso, now);
  if (!Number.isFinite(a)) return "—";
  if (a < MIN) return "now";
  if (a < HOUR) return `${Math.floor(a / MIN)}m ago`;
  if (a < DAY) return `${Math.floor(a / HOUR)}h ago`;
  if (a < 2 * DAY) return "yesterday";
  if (a < 14 * DAY) return `${Math.floor(a / DAY)}d ago`;
  return new Date(Date.parse(iso!)).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function absoluteTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export const DURATION = { MIN, HOUR, DAY };
