import { useEffect, useState } from "react";

/** Current time, rounded to the minute, so layouts recompute at most once a minute. */
export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 60_000) * 60_000);
  useEffect(() => {
    const t = window.setInterval(() => setNow(Math.floor(Date.now() / 60_000) * 60_000), 30_000);
    return () => window.clearInterval(t);
  }, []);
  return now;
}
