import { describe, expect, it } from "vitest";
import { bump, bumpFor, plan } from "./next-version.mjs";

describe("bumpFor", () => {
  it("releases features as minor and fixes as patch", () => {
    expect(bumpFor(["fix: keep titles visible", "feat: add recaps (#9)"])).toBe("minor");
    expect(bumpFor(["fix(launch): quote paths", "docs: typo"])).toBe("patch");
    expect(bumpFor(["perf: cache transcript tails"])).toBe("patch");
  });

  it("doesn't release docs, ci, chores, tests or merges", () => {
    expect(bumpFor(["docs: add user guide", "ci: deploy docs", "chore: bump deps", "test: cover forget", "Bump typescript from 6 to 7 (#3)"])).toBeNull();
  });

  it("treats breaking changes as major", () => {
    expect(bumpFor(["feat!: drop the old index location"])).toBe("major");
    expect(bumpFor(["refactor: new schema\n\nBREAKING CHANGE: needs a rescan"])).toBe("major");
  });

  it("ignores earlier release commits", () => {
    expect(bumpFor(["chore: release v0.2.0 (#13)"])).toBeNull();
  });
});

describe("bump", () => {
  it("bumps minor for breaking changes before 1.0", () => {
    expect(bump("0.2.3", "major")).toBe("0.3.0");
    expect(bump("1.4.2", "major")).toBe("2.0.0");
    expect(bump("0.2.3", "minor")).toBe("0.3.0");
    expect(bump("0.2.3", "patch")).toBe("0.2.4");
  });
});

describe("plan", () => {
  it("tags a version that was bumped but not tagged yet", () => {
    expect(plan({ current: "0.2.0", tagged: false, lastTag: "0.1.0", messages: [] })).toEqual({ mode: "tag", version: "0.2.0" });
  });

  it("proposes the next version from commits since the last tag", () => {
    expect(plan({ current: "0.2.0", tagged: true, lastTag: "0.2.0", messages: ["fix: x", "feat: y"] })).toEqual({ mode: "pr", version: "0.3.0" });
  });

  it("does nothing when only non-releasing commits landed", () => {
    expect(plan({ current: "0.2.0", tagged: true, lastTag: "0.2.0", messages: ["docs: z"] }).mode).toBe("none");
  });

  it("never tags a version older than the last release", () => {
    expect(plan({ current: "0.1.0", tagged: false, lastTag: "0.2.0", messages: ["fix: x"] })).toEqual({ mode: "pr", version: "0.2.1" });
  });
});
