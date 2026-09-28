import { describe, expect, it } from "vitest";
import type { Outcome, Recap } from "../../lib/types";
import { NOW } from "../../test/fixtures";
import { wrapLines } from "./card";
import { periodLabel, periodStart, recapQuery } from "./period";
import { coverageSentences } from "./coverage";
import { buildCard, chatText, DEFAULT_PREFS, defaultHeadline, EMPTY_DRAFT, HOKU_URL, linkedInText, MAX_CARD_OUTCOMES, pickOutcomes, prefsFromSettings, type ShareDraft } from "./share";

function outcome(id: string, text: string, occurredOn = "2026-09-22"): Outcome {
  return { id, text, occurredOn, projectId: "p1", createdAt: "", updatedAt: "" };
}

function recap(p: Partial<Recap> = {}): Recap {
  return {
    since: "2026-09-18T00:00:00.000Z",
    until: "2026-09-24T12:00:00.000Z",
    days: Array.from({ length: 7 }, (_, i) => ({ date: `2026-09-${18 + i}`, sessions: i % 3, observed: i > 2 })),
    totals: { projects: 2, sessions: 14, activeDays: 5, observedSessions: 9, workStarts: 31, readyTransitions: 27, inputRequests: 4 },
    providers: [
      { provider: "claude-code", sessions: 8 },
      { provider: "codex", sessions: 6 },
    ],
    projects: [
      { key: "p1", name: "Secret Client Portal", color: "#8ea8e0", isDemo: false, archived: false, sessions: 9, activeDays: 5, readyTransitions: 20, pullRequests: 1, providers: [], lastActivityAt: null },
      { key: "p2", name: "Acquisition Target", color: null, isDemo: false, archived: false, sessions: 3, activeDays: 2, readyTransitions: 7, pullRequests: 0, providers: [], lastActivityAt: null },
      { key: "unsorted", name: "Unsorted", color: null, isDemo: false, archived: false, sessions: 2, activeDays: 1, readyTransitions: 0, pullRequests: 0, providers: [], lastActivityAt: null },
    ],
    pullRequests: [{ sessionId: "4d44b29a-bb72-4b82-81b2-79126dae948c", projectKey: "p1", url: "https://github.com/acme/secret-portal/pull/9", repo: "acme/secret-portal", number: 9 }],
    outcomes: [outcome("o1", "Shipped the CSV importer"), outcome("o2", "Unblocked the release"), outcome("o3", "Chose a queue"), outcome("o4", "Wrote the runbook")],
    coverage: { retentionDays: 90, historySince: "2026-09-21T09:00:00.000Z", historyCoversRange: false, observedDays: 4, rangeDays: 7 },
    ...p,
  };
}

const draft: ShareDraft = EMPTY_DRAFT;
/** The user ticked every outcome. */
const picked: ShareDraft = { headline: "", outcomeIds: ["o1", "o2", "o3", "o4"] };

function everything(r: Recap, prefs = DEFAULT_PREFS, d = draft): string {
  const c = buildCard(r, "7d", prefs, d);
  return JSON.stringify(c) + linkedInText(c) + chatText(c);
}

describe("share card privacy", () => {
  it("starts with none of the user's outcomes on the card or in the text", () => {
    const c = buildCard(recap(), "7d", DEFAULT_PREFS, EMPTY_DRAFT);
    expect(c.outcomes).toEqual([]);
    expect(c.headline).toBe("My last 7 days of AI-assisted work");
    const out = everything(recap(), DEFAULT_PREFS, EMPTY_DRAFT);
    for (const o of recap().outcomes) expect(out).not.toContain(o.text);
  });

  it("never picks new or recent outcomes by itself", () => {
    const fresh = outcome("new", "Written a minute ago", "2026-09-24");
    const r = recap({ outcomes: [fresh, ...recap().outcomes] });
    expect(pickOutcomes(r.outcomes, EMPTY_DRAFT, "portrait")).toEqual([]);
    // Ticking one outcome shows that one only, not the newer one above it.
    expect(pickOutcomes(r.outcomes, { ...draft, outcomeIds: ["o3"] }, "portrait").map((o) => o.id)).toEqual(["o3"]);
    expect(everything(r, DEFAULT_PREFS, { ...draft, outcomeIds: ["o3"] })).not.toContain("Written a minute ago");
  });

  it("leaves out project names, PR links, repos and ids by default", () => {
    const out = everything(recap());
    for (const secret of ["Secret Client", "Acquisition", "acme", "secret-portal", "github.com/acme", "4d44b29a", "Unsorted", HOKU_URL]) {
      expect(out).not.toContain(secret);
    }
  });

  it("shows a project only under the public name the user chose", () => {
    const prefs = { ...DEFAULT_PREFS, projectLabels: { p1: "Client portal", unsorted: "Should never show" } };
    const c = buildCard(recap(), "7d", prefs, draft);
    expect(c.projects.map((p) => p.label)).toEqual(["Client portal", null]);
    expect(linkedInText(c)).toContain("Projects: Client portal.");
    expect(everything(recap(), prefs)).not.toContain("Secret Client");
    expect(everything(recap(), prefs)).not.toContain("Should never show");
  });

  it("adds the Hoku link only when chosen, and attribution can be turned off", () => {
    expect(linkedInText(buildCard(recap(), "7d", { ...DEFAULT_PREFS, link: true }, draft))).toContain(HOKU_URL);
    const bare = buildCard(recap(), "7d", { ...DEFAULT_PREFS, attribution: false }, draft);
    expect(bare.attribution).toBeNull();
    expect(linkedInText(bare) + chatText(bare)).not.toContain("Hoku");
  });

  it("never shows cost, time or token figures, and Ready counts are opt-in", () => {
    const c = buildCard(recap(), "7d", DEFAULT_PREFS, draft);
    expect(c.stats.map((s) => s.key)).toEqual(["projects", "sessions", "activeDays"]);
    expect(everything(recap())).not.toMatch(/token|hours? saved|cost|productiv|\$/i);
    const withReady = buildCard(recap(), "7d", { ...DEFAULT_PREFS, stats: { ...DEFAULT_PREFS.stats, readyTransitions: true } }, draft);
    expect(withReady.stats.find((s) => s.key === "readyTransitions")?.label).toBe("Turns handed back");
  });
});

describe("share card content", () => {
  it("labels where each kind of content comes from", () => {
    const c = buildCard(recap(), "7d", DEFAULT_PREFS, picked);
    expect(c.footnote).toBe("Outcomes written by me · activity from local session metadata");
    const noOutcomes = buildCard(recap(), "7d", DEFAULT_PREFS, draft);
    expect(noOutcomes.footnote).toBe("Activity from local session metadata");
    expect(linkedInText(c)).toContain("The outcomes are my own notes");
  });

  it("shows exactly the ticked outcomes, in recap order, up to the format's limit", () => {
    const r = recap();
    expect(pickOutcomes(r.outcomes, { ...draft, outcomeIds: ["o4", "o2"] }, "landscape").map((o) => o.id)).toEqual(["o2", "o4"]);
    expect(pickOutcomes(r.outcomes, picked, "landscape")).toHaveLength(MAX_CARD_OUTCOMES.landscape);
    expect(pickOutcomes(r.outcomes, picked, "portrait")).toHaveLength(4);
    // A ticked outcome that left the recap (deleted, other period) is simply gone.
    expect(pickOutcomes(r.outcomes, { ...draft, outcomeIds: ["gone"] }, "landscape")).toEqual([]);
  });

  it("defaults the headline to the period and whether there are outcomes", () => {
    expect(defaultHeadline("30d", true)).toBe("What moved forward in the last 30 days");
    expect(defaultHeadline("7d", false)).toBe("My last 7 days of AI-assisted work");
    expect(defaultHeadline("today", true)).toBe("What moved forward today");
    expect(buildCard(recap(), "7d", DEFAULT_PREFS, { headline: "  Launch week  ", outcomeIds: [] }).headline).toBe("Launch week");
  });

  it("writes plain post text and a compact chat message", () => {
    const c = buildCard(recap(), "7d", DEFAULT_PREFS, picked);
    const post = linkedInText(c);
    expect(post.split("\n")[0]).toBe("What moved forward in the last 7 days");
    expect(post).toContain("→ Shipped the CSV importer");
    expect(post).toContain("2 projects · 14 sessions · 5 active days, with Claude Code and Codex.");
    expect(post).not.toMatch(/\*\*|__/);
    const chat = chatText(c);
    expect(chat).toContain("• Unblocked the release");
    expect(chat).toContain("Activity: 2 projects · 14 sessions · 5 active days, with Claude Code and Codex.");
    expect(chat.split("\n")[0]).toMatch(/^What moved forward in the last 7 days \(Last 7 days · /);
  });

  it("skips the daily rhythm for short periods and hides active days for today", () => {
    const today = recap({ days: [{ date: "2026-09-24", sessions: 3, observed: true }] });
    const c = buildCard(today, "today", DEFAULT_PREFS, draft);
    expect(c.days).toEqual([]);
    expect(c.stats.map((s) => s.key)).not.toContain("activeDays");
    expect(buildCard(recap(), "7d", DEFAULT_PREFS, draft).days).toHaveLength(7);
  });

  it("reads saved preferences defensively", () => {
    expect(prefsFromSettings({})).toEqual(DEFAULT_PREFS);
    const p = prefsFromSettings({ "recaps.share": { format: "bogus", link: "yes", projectLabels: { a: "Alpha", b: 3 }, stats: { sessions: false } } });
    expect(p.format).toBe("landscape");
    expect(p.link).toBe(false);
    expect(p.projectLabels).toEqual({ a: "Alpha" });
    expect(p.stats.sessions).toBe(false);
    expect(p.stats.projects).toBe(true);
  });
});

describe("coverage", () => {
  it("says how much of the period Hoku actually observed", () => {
    const text = coverageSentences(recap()).join(" ");
    expect(text).toContain("on 4 of the 7 days");
    expect(text).toContain("That history starts Sep 21");
    expect(text).toContain("doesn't estimate time, cost or tokens");
    const none = coverageSentences(recap({ coverage: { retentionDays: 90, historySince: null, historyCoversRange: false, observedDays: 0, rangeDays: 7 } })).join(" ");
    expect(none).toContain("no runtime history yet");
  });
});

describe("periods", () => {
  it("start at local midnight and end now", () => {
    const start = periodStart("7d", NOW);
    expect(start.getHours()).toBe(0);
    const days = Math.round((new Date(NOW).setHours(0, 0, 0, 0) - start.getTime()) / 86_400_000);
    expect(days).toBe(6);
    const q = recapQuery("30d", ["p1"], NOW);
    expect(q.until).toBe(new Date(NOW).toISOString());
    expect(q.projects).toEqual(["p1"]);
    expect(Date.parse(q.until) - Date.parse(q.since)).toBeLessThan(91 * 86_400_000);
    expect(q.utcOffsetMinutes).toBe(-new Date(NOW).getTimezoneOffset());
  });

  it("formats period labels", () => {
    expect(periodLabel("2026-09-18", "2026-09-24", "en-US")).toBe("Sep 18 – Sep 24, 2026");
    expect(periodLabel("2025-12-29", "2026-01-04", "en-US")).toBe("Dec 29, 2025 – Jan 4, 2026");
    expect(periodLabel("2026-09-24", "2026-09-24", "en-US")).toBe("Sep 24, 2026");
  });
});

describe("wrapLines", () => {
  const measure = (t: string) => t.length * 10;

  it("wraps on words and ellipsizes past the line limit", () => {
    expect(wrapLines("one two three four", 90, 3, measure)).toEqual(["one two", "three", "four"]);
    const lines = wrapLines("one two three four five six", 90, 2, measure);
    expect(lines).toHaveLength(2);
    expect(lines[1].endsWith("…")).toBe(true);
    expect(measure(lines[1])).toBeLessThanOrEqual(90);
  });

  it("breaks words longer than a line", () => {
    const lines = wrapLines("supercalifragilistic", 80, 4, measure);
    expect(lines.every((l) => measure(l) <= 80)).toBe(true);
    expect(lines.join("")).toBe("supercalifragilistic");
  });

  it("returns nothing for empty text", () => {
    expect(wrapLines("   ", 100, 2, measure)).toEqual([]);
  });
});
