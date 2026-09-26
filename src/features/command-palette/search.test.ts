import { describe, expect, it } from "vitest";
import { search, tokenScore, type SearchDoc } from "./search";

const NOW = Date.parse("2026-09-24T12:00:00Z");

const doc = (id: string, title: string, project: string, provider: string, extra: Partial<SearchDoc> = {}): SearchDoc => ({
  id,
  fields: [
    { text: title, weight: 1.2 },
    { text: project, weight: 1 },
    { text: provider, weight: 0.7 },
  ],
  ...extra,
});

const docs = [
  doc("a", "Backup / DR", "Atlas", "Claude Code"),
  doc("b", "Backup strategy for photos", "Personal Website", "Claude"),
  doc("c", "Obsidian Sync", "Atlas", "Codex"),
  doc("d", "Mobile redesign", "Personal Website", "Codex", { lastActivityAt: new Date(NOW - 60_000).toISOString() }),
];

describe("palette search", () => {
  it("finds 'atlas backup' as the top hit", () => {
    const hits = search("atlas backup", docs, NOW);
    expect(hits[0].id).toBe("a");
    expect(hits.map((h) => h.id)).not.toContain("b");
  });

  it("requires every token to match", () => {
    expect(search("atlas mobile", docs, NOW)).toHaveLength(0);
  });

  it("supports subsequence matching", () => {
    expect(search("obsdn", docs, NOW)[0].id).toBe("c");
    expect(tokenScore("bkp", "backup")).toBeGreaterThan(0);
  });

  it("ignores accents and case", () => {
    const d = [doc("x", "Informação geral", "Evergreen", "Codex")];
    expect(search("INFORMACAO", d, NOW)).toHaveLength(1);
  });

  it("empty query ranks by recency", () => {
    expect(search("", docs, NOW)[0].id).toBe("d");
  });

  it("prefers word-start matches", () => {
    expect(tokenScore("sync", "obsidian sync")).toBeGreaterThan(tokenScore("ync", "obsidian sync"));
  });
});
