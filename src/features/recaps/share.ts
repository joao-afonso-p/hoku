import type { Outcome, Provider, Recap, RecapProject } from "../../lib/types";
import { PROVIDERS } from "../../providers";
import { periodLabel, rangePhrase, type RecapRange } from "./period";

/**
 * What a share card and its post text contain. Built only from the recap's aggregates and
 * the user's own words, so nothing private can leak in by accident: no account names, session
 * titles or ids, paths, prompts, runtime details, notes or PR links ever reach this model. A
 * project's name appears only after the user chose to show it (and they can rename it first).
 */

export type CardFormat = "landscape" | "square" | "portrait";

export const FORMATS: Record<CardFormat, { width: number; height: number; label: string; hint: string }> = {
  landscape: { width: 1200, height: 630, label: "Landscape", hint: "1200 × 630 · link previews, Slack, Teams" },
  square: { width: 1080, height: 1080, label: "Square", hint: "1080 × 1080 · LinkedIn feed" },
  portrait: { width: 1080, height: 1350, label: "Portrait", hint: "1080 × 1350 · LinkedIn mobile" },
};

/** Card outcomes per format. A recap is a few milestones, not a changelog. */
export const MAX_CARD_OUTCOMES: Record<CardFormat, number> = { landscape: 3, square: 4, portrait: 5 };

export type StatKey = "projects" | "sessions" | "activeDays" | "readyTransitions" | "pullRequests";

export const STAT_LABELS: Record<StatKey, { label: string; hint: string }> = {
  projects: { label: "Projects", hint: "Named projects with activity in the period" },
  sessions: { label: "Sessions", hint: "Sessions with provider or observed activity in the period" },
  activeDays: { label: "Active days", hint: "Days with at least one active session" },
  readyTransitions: { label: "Turns handed back", hint: "Observed Ready transitions while Hoku was open. A finished turn, not a finished task." },
  pullRequests: { label: "Linked PRs", hint: "Pull requests linked in Claude Code sessions. Not necessarily merged." },
};

export const HOKU_URL = "github.com/joao-afonso-p/hoku";

/** Persisted under the settings key [SHARE_KEY]. Headline and outcome picks are per recap, not saved. */
export interface SharePrefs {
  format: CardFormat;
  stats: Record<StatKey, boolean>;
  providers: boolean;
  activity: boolean;
  /** A subtle "Recapped with Hoku" line. */
  attribution: boolean;
  /** Adds the Hoku repository URL to the card and text. Off by default. */
  link: boolean;
  /** Project id → public label. Absent means the project stays unnamed. */
  projectLabels: Record<string, string>;
}

export const SHARE_KEY = "recaps.share";

export const DEFAULT_PREFS: SharePrefs = {
  format: "landscape",
  stats: { projects: true, sessions: true, activeDays: true, readyTransitions: false, pullRequests: false },
  providers: true,
  activity: true,
  attribution: true,
  link: false,
  projectLabels: {},
};

export function prefsFromSettings(settings: Record<string, unknown>): SharePrefs {
  const v = settings[SHARE_KEY];
  if (!v || typeof v !== "object") return DEFAULT_PREFS;
  const p = v as Partial<SharePrefs>;
  const labels: Record<string, string> = {};
  if (p.projectLabels && typeof p.projectLabels === "object") {
    for (const [k, l] of Object.entries(p.projectLabels)) if (typeof l === "string") labels[k] = l;
  }
  return {
    format: p.format && p.format in FORMATS ? p.format : DEFAULT_PREFS.format,
    stats: { ...DEFAULT_PREFS.stats, ...(typeof p.stats === "object" ? p.stats : {}) },
    providers: typeof p.providers === "boolean" ? p.providers : DEFAULT_PREFS.providers,
    activity: typeof p.activity === "boolean" ? p.activity : DEFAULT_PREFS.activity,
    attribution: typeof p.attribution === "boolean" ? p.attribution : DEFAULT_PREFS.attribution,
    link: typeof p.link === "boolean" ? p.link : DEFAULT_PREFS.link,
    projectLabels: labels,
  };
}

/** Per-recap choices: an edited headline and which outcomes to show. */
export interface ShareDraft {
  headline: string;
  /**
   * Outcomes the user ticked for this recap. Starts empty and is never filled in for them:
   * an outcome reaches the card or the text only after an explicit tick, never because it's
   * new or recent.
   */
  outcomeIds: string[];
}

export const EMPTY_DRAFT: ShareDraft = { headline: "", outcomeIds: [] };

export interface CardStat {
  key: StatKey;
  value: string;
  label: string;
}

export interface CardProject {
  /** null = unnamed on the card; drawn as a star without a label. */
  label: string | null;
  color: string;
  /** 0..1, relative activity. Drives size, never printed. */
  weight: number;
}

export interface CardProvider {
  provider: Provider;
  label: string;
  accent: string;
  share: number;
}

export interface CardContent {
  format: CardFormat;
  /** "Last 7 days · Sep 21 – Sep 27, 2026". The card shows it as an uppercase eyebrow. */
  period: string;
  headline: string;
  outcomes: string[];
  stats: CardStat[];
  providers: CardProvider[];
  projects: CardProject[];
  /** Relative daily activity, oldest first; `observed` = Hoku's runtime history covers the day. */
  days: { level: number; observed: boolean }[];
  /** Where each kind of content comes from. Always on the card. */
  footnote: string;
  attribution: string | null;
}

const STAR = "#f1ead8";

export function defaultHeadline(range: RecapRange, hasOutcomes: boolean): string {
  if (hasOutcomes) return range === "today" ? "What moved forward today" : `What moved forward in ${rangePhrase(range)}`;
  return range === "today" ? "Today's AI-assisted work" : `My ${rangePhrase(range).replace(/^the /, "")} of AI-assisted work`;
}

/** The ticked outcomes still in this recap, in its order, up to the format's limit. Nothing ticked = none. */
export function pickOutcomes(outcomes: Outcome[], draft: ShareDraft, format: CardFormat): Outcome[] {
  const chosen = new Set(draft.outcomeIds);
  return outcomes.filter((o) => chosen.has(o.id)).slice(0, MAX_CARD_OUTCOMES[format]);
}

/** A public label for a project, or null while the user hasn't chosen to name it. Unsorted never gets one. */
export function projectLabel(p: RecapProject, prefs: SharePrefs): string | null {
  if (p.key === "unsorted") return null;
  const l = prefs.projectLabels[p.key]?.trim();
  return l ? l.slice(0, 40) : null;
}

export function buildCard(recap: Recap, range: RecapRange, prefs: SharePrefs, draft: ShareDraft): CardContent {
  const outcomes = pickOutcomes(recap.outcomes, draft, prefs.format).map((o) => o.text);
  const first = recap.days[0]?.date ?? recap.since.slice(0, 10);
  const last = recap.days[recap.days.length - 1]?.date ?? recap.until.slice(0, 10);
  const period = periodLabel(first, last);
  const phrase = rangePhrase(range).replace(/^the /, "");
  const periodText = range === "today" ? `Today · ${period}` : `${phrase[0].toUpperCase()}${phrase.slice(1)} · ${period}`;

  const t = recap.totals;
  const values: Record<StatKey, number> = {
    projects: t.projects,
    sessions: t.sessions,
    activeDays: t.activeDays,
    readyTransitions: t.readyTransitions,
    // Per-project counts are complete; the listed PRs are capped.
    pullRequests: recap.projects.reduce((n, p) => n + p.pullRequests, 0),
  };
  const stats: CardStat[] = (Object.keys(STAT_LABELS) as StatKey[])
    .filter((k) => prefs.stats[k])
    // "Today" has one day by definition.
    .filter((k) => !(k === "activeDays" && range === "today"))
    .map((k) => ({ key: k, value: values[k].toLocaleString(), label: values[k] === 1 ? singular(STAT_LABELS[k].label) : STAT_LABELS[k].label }));

  const totalSessions = recap.providers.reduce((n, p) => n + p.sessions, 0);
  const providers: CardProvider[] = prefs.providers && totalSessions > 0
    ? recap.providers.map((p) => ({ provider: p.provider, label: PROVIDERS[p.provider].label, accent: PROVIDERS[p.provider].accent, share: p.sessions / totalSessions }))
    : [];

  const named = recap.projects.filter((p) => p.key !== "unsorted");
  const maxDays = Math.max(1, ...named.map((p) => p.activeDays));
  const projects: CardProject[] = named.slice(0, 7).map((p) => ({
    label: projectLabel(p, prefs),
    color: p.color ?? STAR,
    weight: p.activeDays / maxDays,
  }));

  const maxDay = Math.max(1, ...recap.days.map((d) => d.sessions));
  const days = prefs.activity && recap.days.length >= 3 ? recap.days.map((d) => ({ level: d.sessions / maxDay, observed: d.observed })) : [];

  return {
    format: prefs.format,
    period: periodText,
    headline: draft.headline.trim() || defaultHeadline(range, outcomes.length > 0),
    outcomes,
    stats,
    providers,
    projects,
    days,
    footnote: outcomes.length > 0 ? "Outcomes written by me · activity from local session metadata" : "Activity from local session metadata",
    attribution: prefs.attribution ? (prefs.link ? `Recapped with Hoku · ${HOKU_URL}` : "Recapped with Hoku") : prefs.link ? HOKU_URL : null,
  };
}

function singular(label: string): string {
  if (label === "Active days") return "Active day";
  if (label === "Linked PRs") return "Linked PR";
  if (label === "Turns handed back") return "Turn handed back";
  return label.replace(/s$/, "");
}

function listProviders(c: CardContent): string {
  const names = c.providers.map((p) => p.label);
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function statsSentence(c: CardContent): string {
  const parts = c.stats.map((s) => `${s.value} ${s.label.toLowerCase()}`);
  if (parts.length === 0) return "";
  return parts.join(" · ");
}

/** LinkedIn post text: plain (LinkedIn doesn't render Markdown), outcomes first. */
export function linkedInText(c: CardContent): string {
  const lines: string[] = [c.headline, ""];
  if (c.outcomes.length) {
    for (const o of c.outcomes) lines.push(`→ ${o}`);
    lines.push("");
  }
  const stats = statsSentence(c);
  const providers = listProviders(c);
  const names = c.projects.map((p) => p.label).filter(Boolean);
  if (stats) lines.push(`${stats}${providers ? `, with ${providers}` : ""}.`);
  else if (providers) lines.push(`Worked with ${providers}.`);
  if (names.length) lines.push(`Projects: ${names.join(", ")}.`);
  if (stats || providers || names.length) lines.push("");
  lines.push(c.outcomes.length ? "The outcomes are my own notes; the activity comes from local session metadata." : "Activity comes from local session metadata.");
  if (c.attribution) lines.push(c.attribution);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Slack / Teams text: compact, bullets, no Markdown that one of them would show literally. */
export function chatText(c: CardContent): string {
  const lines: string[] = [`${c.headline} (${c.period})`];
  for (const o of c.outcomes) lines.push(`• ${o}`);
  const stats = statsSentence(c);
  const providers = listProviders(c);
  const names = c.projects.map((p) => p.label).filter(Boolean);
  const activity = [stats, providers && `with ${providers}`, names.length ? `on ${names.join(", ")}` : ""].filter(Boolean).join(", ");
  if (activity) lines.push(`Activity: ${activity}.`);
  lines.push(c.outcomes.length ? "Outcomes written by me; activity from local session metadata." : "From local session metadata.");
  if (c.attribution) lines.push(c.attribution);
  return lines.join("\n");
}
