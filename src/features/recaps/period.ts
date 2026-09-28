import type { RecapQuery } from "../../lib/types";

/** Periods always end now, so "last activity after the start" is exact. At most 90 days: the runtime history's retention. */
export type RecapRange = "today" | "7d" | "30d" | "90d";

export const RANGES: { key: RecapRange; label: string; days: number }[] = [
  { key: "today", label: "Today", days: 0 },
  { key: "7d", label: "7 days", days: 7 },
  { key: "30d", label: "30 days", days: 30 },
  { key: "90d", label: "90 days", days: 90 },
];

/** Local midnight `days` days before `now` (today's midnight for 0), so every day in the period is whole. */
export function periodStart(range: RecapRange, now = Date.now()): Date {
  const days = RANGES.find((r) => r.key === range)!.days;
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  // A 7-day recap is today plus the 6 days before it.
  d.setDate(d.getDate() - Math.max(0, days - 1));
  return d;
}

export function recapQuery(range: RecapRange, projects: string[], now = Date.now()): RecapQuery {
  return {
    since: periodStart(range, now).toISOString(),
    until: new Date(now).toISOString(),
    utcOffsetMinutes: -new Date(now).getTimezoneOffset(),
    projects,
  };
}

/** "today", "the last 7 days" */
export function rangePhrase(range: RecapRange): string {
  return range === "today" ? "today" : `the last ${RANGES.find((r) => r.key === range)!.days} days`;
}

const MONTH_DAY: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };

/** YYYY-MM-DD read as a local calendar day (not UTC midnight). */
export function localDay(date: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function dayKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "Sep 27, 2026" or "Aug 29 – Sep 27, 2026". */
export function periodLabel(firstDay: string, lastDay: string, locale?: string): string {
  const a = localDay(firstDay);
  const b = localDay(lastDay);
  const year = b.getFullYear();
  if (firstDay === lastDay) return b.toLocaleDateString(locale, { ...MONTH_DAY, year: "numeric" });
  const from = a.toLocaleDateString(locale, a.getFullYear() === year ? MONTH_DAY : { ...MONTH_DAY, year: "numeric" });
  return `${from} – ${b.toLocaleDateString(locale, { ...MONTH_DAY, year: "numeric" })}`;
}

export function shortDay(date: string, locale?: string): string {
  return localDay(date).toLocaleDateString(locale, MONTH_DAY);
}
