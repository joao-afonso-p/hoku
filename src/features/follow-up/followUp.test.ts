import { describe, expect, it } from "vitest";
import { session } from "../../test/fixtures";
import type { FollowUp } from "../../lib/types";
import { dueCount, dueLabel, followUpKey, fromLocalInput, groupFollowUps, openedSince, queued, snoozePresets, sortFollowUps, toLocalInput, type Queued } from "./followUp";

// Local wall-clock times, so the tests hold in any time zone.
const at = (d: number, h: number, m = 0) => new Date(2026, 8, d, h, m).getTime();
const iso = (t: number) => new Date(t).toISOString();
const NOW = at(24, 12); // Thursday, Sep 24, 12:00

const fu = (dueAt: number | null, addedAt = at(24, 8)): FollowUp => ({ addedAt: iso(addedAt), dueAt: dueAt === null ? null : iso(dueAt) });

describe("follow up state", () => {
  it("separates undated, scheduled, due today and overdue", () => {
    expect(followUpKey(fu(null), NOW)).toBe("open");
    expect(followUpKey(fu(at(24, 15)), NOW)).toBe("scheduled");
    expect(followUpKey(fu(at(24, 9)), NOW)).toBe("due");
    expect(followUpKey(fu(NOW), NOW)).toBe("due");
    expect(followUpKey(fu(at(23, 23, 30)), NOW)).toBe("overdue");
  });

  it("counts only reminders that went off", () => {
    const list = [session({ followUp: fu(at(24, 9)) }), session({ followUp: fu(at(20, 9)) }), session({ followUp: fu(null) }), session({ followUp: fu(at(25, 9)) }), session()];
    expect(dueCount(list, NOW)).toBe(2);
    expect(queued(list)).toHaveLength(4);
  });

  it("labels are about the reminder, not the session", () => {
    expect(dueLabel(fu(null), NOW)).toBe("No date");
    expect(dueLabel(fu(at(24, 9, 5)), NOW)).toBe("Due 09:05");
    expect(dueLabel(fu(at(22, 12)), NOW)).toBe("Overdue · 2d");
    expect(dueLabel(fu(at(24, 17, 30)), NOW)).toBe("Today 17:30");
    expect(dueLabel(fu(at(25, 9)), NOW)).toBe("Tomorrow 09:00");
  });

  it("notices when the session was opened after it was queued", () => {
    const s = session({ followUp: fu(null, at(24, 8)), lastOpenedAt: iso(at(24, 10)) }) as Queued;
    expect(openedSince(s)).toBe(true);
    expect(openedSince({ ...s, lastOpenedAt: iso(at(24, 7)) })).toBe(false);
  });
});

describe("queue order and grouping", () => {
  const overdue = session({ id: "overdue", projectId: "b", followUp: fu(at(21, 9)) }) as Queued;
  const dueToday = session({ id: "due", projectId: "a", followUp: fu(at(24, 11)) }) as Queued;
  const openOld = session({ id: "open-old", projectId: "a", followUp: fu(null, at(20, 8)) }) as Queued;
  const openNew = session({ id: "open-new", projectId: null, followUp: fu(null, at(24, 8)) }) as Queued;
  const soon = session({ id: "soon", projectId: "b", followUp: fu(at(24, 18)) }) as Queued;
  const later = session({ id: "later", projectId: "a", followUp: fu(at(28, 9)) }) as Queued;
  const all = [later, openNew, soon, dueToday, openOld, overdue];
  const ids = (list: { id: string }[]) => list.map((s) => s.id);

  it("puts due first, then undated oldest first, then scheduled soonest first", () => {
    expect(ids(sortFollowUps(all, NOW))).toEqual(["overdue", "due", "open-old", "open-new", "soon", "later"]);
  });

  it("groups by date section", () => {
    const groups = groupFollowUps(all, "date", () => ({ key: "", label: "" }), NOW);
    expect(groups.map((g) => [g.label, ids(g.items)])).toEqual([
      ["Due", ["overdue", "due"]],
      ["No date", ["open-old", "open-new"]],
      ["Scheduled", ["soon", "later"]],
    ]);
  });

  it("groups by project, most urgent project first", () => {
    const projectOf = (s: { projectId?: string | null }) => ({ key: s.projectId ?? "unsorted", label: s.projectId ?? "Unsorted" });
    const groups = groupFollowUps(all, "project", projectOf, NOW);
    expect(groups.map((g) => [g.key, ids(g.items)])).toEqual([
      ["b", ["overdue", "soon"]],
      ["a", ["due", "open-old", "later"]],
      ["unsorted", ["open-new"]],
    ]);
  });
});

describe("snooze", () => {
  it("offers later today, tomorrow morning and next Monday", () => {
    const [later, tomorrow, nextWeek] = snoozePresets(at(24, 12, 7));
    expect(later.at).toBe(at(24, 15, 15));
    expect(tomorrow.at).toBe(at(25, 9));
    expect(nextWeek.at).toBe(at(28, 9));
    // On a Monday, next week is the following Monday.
    expect(snoozePresets(at(28, 10))[2].at).toBe(at(28 + 7, 9));
  });

  it("round-trips the date picker's local time", () => {
    const t = at(30, 8, 45);
    expect(toLocalInput(t)).toBe("2026-09-30T08:45");
    expect(fromLocalInput(toLocalInput(t))).toBe(t);
    expect(fromLocalInput("")).toBeNull();
    expect(fromLocalInput("next tuesday")).toBeNull();
  });
});
