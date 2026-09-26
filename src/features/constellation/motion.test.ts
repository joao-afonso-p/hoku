import { describe, expect, it } from "vitest";
import { rt, session } from "../../test/fixtures";
import { diffStates } from "./motion";

describe("semantic motion", () => {
  const a = session({ runtime: rt("working") });
  const b = session({ runtime: rt("idle") });

  it("never pulses on first sight", () => {
    expect(diffStates(new Map(), [a, b]).changed).toEqual([]);
  });

  it("pulses once per real change, to the new state", () => {
    const { next } = diffStates(new Map(), [a, b]);
    const done = { ...a, runtime: rt("ready") };
    const waiting = { ...b, runtime: rt("needs_input") };
    expect(diffStates(next, [done, waiting]).changed).toEqual([
      [a.id, "ready"],
      [b.id, "needs_you"],
    ]);
    // Same states again: nothing.
    expect(diffStates(diffStates(next, [done, waiting]).next, [done, waiting]).changed).toEqual([]);
  });

  it("stays quiet when a session goes idle or offline", () => {
    const { next } = diffStates(new Map(), [a]);
    expect(diffStates(next, [{ ...a, runtime: rt("offline") }]).changed).toEqual([]);
  });
});
