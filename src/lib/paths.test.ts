import { describe, expect, it } from "vitest";
import { tildify } from "./paths";

describe("tildify", () => {
  it("collapses a macOS home directory", () => {
    expect(tildify("/Users/me/Library/Application Support/com.hoku.app/hub.sqlite")).toBe(
      "~/Library/Application Support/com.hoku.app/hub.sqlite",
    );
  });

  it("collapses a Linux home directory", () => {
    expect(tildify("/home/me/.local/share/com.hoku.app/hub.sqlite")).toBe("~/.local/share/com.hoku.app/hub.sqlite");
  });

  it("leaves a path outside home alone", () => {
    expect(tildify("/usr/bin/claude")).toBe("/usr/bin/claude");
  });

  it("does not keep the first home when the next path is on the other OS", () => {
    expect(tildify("/home/me/.local/share/com.hoku.app/hub.sqlite")).toBe("~/.local/share/com.hoku.app/hub.sqlite");
    expect(tildify("/Users/me/Library/Application Support/com.hoku.app/hub.sqlite")).toBe(
      "~/Library/Application Support/com.hoku.app/hub.sqlite",
    );
  });
});
