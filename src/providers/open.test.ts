import { describe, expect, it } from "vitest";
import { rt, session } from "../test/fixtures";
import { openHint } from "./index";

function withUserAgent(ua: string, body: () => void) {
  const previous = Object.getOwnPropertyDescriptor(navigator, "userAgent");
  Object.defineProperty(navigator, "userAgent", { configurable: true, get: () => ua });
  try {
    body();
  } finally {
    if (previous) Object.defineProperty(navigator, "userAgent", previous);
    else delete (navigator as { userAgent?: string }).userAgent;
  }
}

const linux = "Mozilla/5.0 (X11; Linux x86_64)";
const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0)";

describe("openHint", () => {
  const resume = session({
    provider: "claude-code",
    workingDirectory: "/home/me/app",
    runtime: rt("offline"),
  });
  const attached = session({
    provider: "claude-code",
    runtime: rt("working", { source: "claude-code-registry" }),
    metadata: { live: { kind: "bg" } },
  });

  it("names a terminal window on Linux and an iTerm tab on macOS", () => {
    withUserAgent(linux, () => {
      expect(openHint(resume, "auto")).toBe("Will resume it in a new terminal window in ~/app");
      expect(openHint(attached, "iterm")).toBe("Will attach to the running background session in a new terminal window");
    });
    withUserAgent(mac, () => {
      expect(openHint(resume, "auto")).toContain("iTerm tab");
      expect(openHint(resume, "terminal")).toContain("Terminal window");
      expect(openHint(attached, "auto")).toContain("iTerm tab");
    });
  });

  it("does not hint a demo session", () => {
    withUserAgent(linux, () => {
      expect(openHint(session({ provider: "claude-code", source: "demo" }), "auto")).toBeUndefined();
    });
  });
});
