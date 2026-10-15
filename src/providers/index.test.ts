import { describe, expect, it } from "vitest";
import { session } from "../test/fixtures";
import { openDescription, surfaceLabel } from "./index";

describe("provider surface labels and open descriptions", () => {
  it("labels a remote Cowork session as Claude Cowork and offers to open Claude Desktop", () => {
    const remote = session({
      provider: "claude",
      source: "claude-cowork-remote",
      deepLink: null,
      metadata: { surface: "cowork", remote: true, openUnverified: true },
    });
    expect(surfaceLabel(remote)).toBe("Claude Cowork");
    expect(openDescription(remote)).toBe("Open Claude Desktop");
  });

  it("leaves the local Cowork session unchanged", () => {
    const local = session({
      provider: "claude",
      source: "claude-cowork",
      deepLink: "claude://claude.ai/local_sessions/local_x",
      metadata: { surface: "cowork" },
    });
    expect(surfaceLabel(local)).toBe("Claude Cowork");
    expect(openDescription(local)).toBe("Open in Claude Cowork");
  });

  it("keeps the plain Claude conversation wording", () => {
    const chat = session({ provider: "claude", metadata: null });
    expect(surfaceLabel(chat)).toBe("Claude");
    expect(openDescription(chat)).toBe("Open conversation in Claude");
  });
});
