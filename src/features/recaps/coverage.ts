import type { Recap } from "../../lib/types";
import { shortDay } from "./period";

/** How much of the period Hoku actually saw, in plain words. Shown next to every recap. */
export function coverageSentences(recap: Recap): string[] {
  const c = recap.coverage;
  const out = [
    `Hoku records runtime transitions only while it's open, and keeps ${c.retentionDays} days of them. It recorded some on ${c.observedDays} of the ${c.rangeDays} ${c.rangeDays === 1 ? "day" : "days"} in this period.`,
  ];
  if (!c.historyCoversRange) {
    out.push(
      c.historySince
        ? `That history starts ${shortDay(c.historySince.slice(0, 10))}. Before then, a session shows up only through its latest provider timestamp.`
        : "There's no runtime history yet, so sessions show up only through their latest provider timestamp.",
    );
  }
  out.push("Counts are sessions and days, not effort. Hoku doesn't estimate time, cost or tokens.");
  return out;
}
