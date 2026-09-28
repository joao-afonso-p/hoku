import { describe, expect, it } from "vitest";
import { rt, session } from "../../test/fixtures";
import { DEFAULT_NOTIFICATION_PREFS, notificationDestination, notificationPrefs, NOTIFY_KEYS } from "./notifications";

describe("notification preferences", () => {
  it("default to the Dock badge only", () => {
    expect(notificationPrefs({})).toEqual({ banners: false, badge: true, bounce: false });
    expect(DEFAULT_NOTIFICATION_PREFS.bounce).toBe(false);
  });

  it("read the stored switches and ignore junk", () => {
    expect(notificationPrefs({ [NOTIFY_KEYS.banners]: true, [NOTIFY_KEYS.badge]: false, [NOTIFY_KEYS.bounce]: true })).toEqual({ banners: true, badge: false, bounce: true });
    expect(notificationPrefs({ [NOTIFY_KEYS.badge]: "no" }).badge).toBe(true);
  });
});

describe("a clicked banner", () => {
  const waiting = session({ runtime: rt("needs_input", { reason: "Waiting for permission" }) });
  const answered = session({ runtime: rt("working") });

  it("leads to that exact session", () => {
    expect(notificationDestination({ sessionId: waiting.id }, [answered, waiting])).toEqual({ kind: "session", session: waiting });
  });

  it("still leads to a session that no longer needs you", () => {
    expect(notificationDestination({ sessionId: answered.id }, [answered])).toEqual({ kind: "session", session: answered });
  });

  it("falls back to the inbox when the session is gone", () => {
    expect(notificationDestination({ sessionId: "deleted" }, [waiting])).toEqual({ kind: "inbox", missing: true });
  });

  it("opens the inbox for a summary banner", () => {
    expect(notificationDestination({ sessionId: null }, [waiting])).toEqual({ kind: "inbox", missing: false });
  });
});
