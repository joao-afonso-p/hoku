/**
 * Semantic motion: the Galaxy moves only to say something changed. A session that changes
 * state gets one soft ripple (and Needs You a brief swell as its amber fades in); nothing
 * loops except the slow Working breath. First paint and data reloads with no state change
 * produce nothing. See docs/constellation-layout.md → Motion.
 */
import { useEffect, useRef, useState } from "react";
import type { Session } from "../../lib/types";
import { statusKey, type StatusKey } from "../runtime/status";

export interface Pulse {
  to: StatusKey;
  /** Restart key: a new transition on the same node replays the animation. */
  at: number;
}

/** Transitions worth a ripple. Going quiet (idle, offline, unknown) isn't news. */
const RIPPLE_ON: ReadonlySet<StatusKey> = new Set(["needs_you", "working", "ready", "error"]);
export const PULSE_MS = 1400;

/** Compare with the last known states. Sessions seen for the first time never pulse. */
export function diffStates(prev: ReadonlyMap<string, StatusKey>, sessions: Session[]): { next: Map<string, StatusKey>; changed: [string, StatusKey][] } {
  const next = new Map<string, StatusKey>();
  const changed: [string, StatusKey][] = [];
  for (const s of sessions) {
    const key = statusKey(s);
    next.set(s.id, key);
    const before = prev.get(s.id);
    if (before !== undefined && before !== key && RIPPLE_ON.has(key)) changed.push([s.id, key]);
  }
  return { next, changed };
}

export function useStatePulses(sessions: Session[]): ReadonlyMap<string, Pulse> {
  const prev = useRef<Map<string, StatusKey> | null>(null);
  const [pulses, setPulses] = useState<Map<string, Pulse>>(() => new Map());
  useEffect(() => {
    if (!prev.current) {
      prev.current = diffStates(new Map(), sessions).next;
      return;
    }
    const { next, changed } = diffStates(prev.current, sessions);
    prev.current = next;
    if (changed.length === 0) return;
    const at = Date.now();
    setPulses((p) => {
      const m = new Map(p);
      for (const [id, to] of changed) m.set(id, { to, at });
      return m;
    });
    const t = window.setTimeout(() => {
      setPulses((p) => {
        const m = new Map(p);
        for (const [id] of changed) if (m.get(id)?.at === at) m.delete(id);
        return m;
      });
    }, PULSE_MS);
    return () => window.clearTimeout(t);
  }, [sessions]);
  return pulses;
}
