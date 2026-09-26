/**
 * Palette ranking. Every query token must match some field (AND semantics), so
 * "atlas backup" means project Atlas *and* something about backup.
 */
import { ageMs, DURATION } from "../../lib/time";

export interface SearchDoc {
  id: string;
  /** Weighted fields; earlier = more important. */
  fields: { text: string; weight: number }[];
  lastActivityAt?: string | null;
  lastOpenedAt?: string | null;
  active?: boolean;
  /** Waiting on the user right now: floats to the top of an empty query. */
  attention?: boolean;
  favorite?: boolean;
}

export interface SearchHit {
  id: string;
  score: number;
}

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/** Score one token against one field. 0 = no match. */
export function tokenScore(token: string, text: string): number {
  if (!token) return 0;
  const idx = text.indexOf(token);
  if (idx >= 0) {
    const atWordStart = idx === 0 || /[\s/·._\-()[\]]/.test(text[idx - 1]);
    const exactWord = atWordStart && (idx + token.length === text.length || /[\s/·._\-()]/.test(text[idx + token.length]));
    return exactWord ? 10 : atWordStart ? 8 : 5;
  }
  // Subsequence match, penalised by spread — lets "bkp" find "backup".
  if (token.length < 3) return 0;
  let ti = 0;
  let first = -1;
  let last = -1;
  for (let i = 0; i < text.length && ti < token.length; i++) {
    if (text[i] === token[ti]) {
      if (first < 0) first = i;
      last = i;
      ti++;
    }
  }
  if (ti < token.length) return 0;
  const spread = last - first + 1;
  const density = token.length / spread;
  return density > 0.45 ? 1 + 2 * density : 0;
}

export function search(query: string, docs: SearchDoc[], now = Date.now(), limit = 40): SearchHit[] {
  const tokens = normalize(query).split(/\s+/).filter(Boolean);
  const hits: SearchHit[] = [];
  for (const doc of docs) {
    const fields = doc.fields.map((f) => ({ text: normalize(f.text), weight: f.weight }));
    let score = 0;
    let all = true;
    for (const t of tokens) {
      let best = 0;
      for (const f of fields) best = Math.max(best, tokenScore(t, f.text) * f.weight);
      if (best === 0) {
        all = false;
        break;
      }
      score += best;
    }
    if (!all) continue;
    score += boost(doc, now, tokens.length === 0 ? 3 : 1);
    hits.push({ id: doc.id, score });
  }
  hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  return hits.slice(0, limit);
}

/** Recency, activity and what you opened recently. Stronger when the query is empty. */
function boost(doc: SearchDoc, now: number, factor: number): number {
  let b = 0;
  const activity = ageMs(doc.lastActivityAt, now);
  if (activity < DURATION.HOUR) b += 3;
  else if (activity < DURATION.DAY) b += 2;
  else if (activity < 7 * DURATION.DAY) b += 1;
  const opened = ageMs(doc.lastOpenedAt, now);
  if (opened < DURATION.DAY) b += 2.5;
  else if (opened < 7 * DURATION.DAY) b += 1;
  if (doc.active) b += 2;
  if (doc.attention) b += 3;
  if (doc.favorite) b += 1.5;
  return b * factor;
}
