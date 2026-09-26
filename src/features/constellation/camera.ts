import { useCallback, useEffect, useReducer, useRef } from "react";

/** World-space camera. `t` is Project Focus progress (0 = galaxy, 1 = focused). */
export interface Camera {
  x: number;
  y: number;
  zoom: number;
  t: number;
}

const easeOutCubic = (k: number) => 1 - Math.pow(1 - k, 3);
const easeInOutCubic = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);

function lerp(a: number, b: number, k: number) {
  return a + (b - a) * k;
}

export function useCamera(initial: Camera) {
  const cam = useRef<Camera>(initial);
  const frame = useRef<number | null>(null);
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  const cancel = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  }, []);

  const set = useCallback(
    (next: Camera) => {
      cancel();
      cam.current = next;
      rerender();
    },
    [cancel],
  );

  const animateTo = useCallback(
    (target: Camera, ms = 420, done?: () => void, curve: "out" | "inOut" = "inOut") => {
      cancel();
      const from = { ...cam.current };
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const duration = reduce ? 1 : ms;
      const start = performance.now();
      const ease = curve === "out" ? easeOutCubic : easeInOutCubic;
      const step = (now: number) => {
        const k = ease(Math.min(1, (now - start) / duration));
        cam.current = {
          x: lerp(from.x, target.x, k),
          y: lerp(from.y, target.y, k),
          // Interpolate zoom logarithmically so zooming feels even.
          zoom: Math.exp(lerp(Math.log(from.zoom), Math.log(target.zoom), k)),
          t: lerp(from.t, target.t, k),
        };
        rerender();
        if (k < 1) frame.current = requestAnimationFrame(step);
        else {
          frame.current = null;
          done?.();
        }
      };
      frame.current = requestAnimationFrame(step);
    },
    [cancel],
  );

  useEffect(() => cancel, [cancel]);

  return { cam: cam.current, camRef: cam, set, animateTo, animating: () => frame.current !== null };
}
