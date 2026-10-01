import { afterEach, describe, expect, it } from "vitest";
import { here, isLinuxHost } from "./host";

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

afterEach(() => {
  delete (navigator as { userAgent?: string }).userAgent;
});

describe("host wording", () => {
  it("treats a desktop Linux user agent as this computer", () => {
    withUserAgent("Mozilla/5.0 (X11; Linux x86_64)", () => {
      expect(isLinuxHost()).toBe(true);
      expect(here()).toBe("this computer");
    });
  });

  it("keeps macOS wording, including when Node has no Linux user agent", () => {
    withUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0)", () => {
      expect(isLinuxHost()).toBe(false);
      expect(here()).toBe("this Mac");
    });
    expect(isLinuxHost()).toBe(false);
    expect(here()).toBe("this Mac");
  });

  it("does not treat Android as the Linux desktop port", () => {
    withUserAgent("Mozilla/5.0 (Linux; Android 14)", () => {
      expect(isLinuxHost()).toBe(false);
      expect(here()).toBe("this Mac");
    });
  });
});
