import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { copy, fail, reveal, toast } from "../../app/actions";
import { UNSORTED } from "../../app/model";
import { getState, setState, useHub } from "../../app/store";
import { IconCheck, IconCopy, IconDownload, IconEdit, IconTrash } from "../../components/Icons";
import { MultiSelect } from "../../components/MultiSelect";
import { api } from "../../lib/api";
import { relativeTime } from "../../lib/time";
import type { HubError, Outcome, Recap, RecapProject } from "../../lib/types";
import { PROVIDERS } from "../../providers";
import { GlyphIcon } from "../constellation/Glyph";
import { drawCard, loadMark, renderPng } from "./card";
import { coverageSentences } from "./coverage";
import { dayKey, periodLabel, RANGES, recapQuery, shortDay, type RecapRange } from "./period";
import {
  buildCard,
  chatText,
  EMPTY_DRAFT,
  FORMATS,
  linkedInText,
  MAX_CARD_OUTCOMES,
  pickOutcomes,
  prefsFromSettings,
  SHARE_KEY,
  STAT_LABELS,
  type CardContent,
  type CardFormat,
  type ShareDraft,
  type SharePrefs,
  type StatKey,
} from "./share";

const OUTCOME_MAX = 140;

function useRecap(range: RecapRange, projects: string[]) {
  const data = useHub((s) => s.data);
  const [recap, setRecap] = useState<Recap | null>(null);
  const [error, setError] = useState<HubError | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let live = true;
    api
      .recap(recapQuery(range, projects))
      .then((r) => {
        if (!live) return;
        setRecap(r);
        setError(null);
      })
      .catch((e: HubError) => live && setError(e));
    return () => {
      live = false;
    };
    // `data` changes whenever the snapshot reloads (runtime transitions, scans, edits).
  }, [range, projects, data, nonce]);
  return { recap, error, refresh: () => setNonce((n) => n + 1) };
}

/** Share preferences, saved as one setting. Typing a project label saves once the typing stops. */
function usePrefs(): [SharePrefs, (patch: Partial<SharePrefs>) => void] {
  const [prefs, setPrefs] = useState<SharePrefs>(() => prefsFromSettings(getState().data.settings));
  const current = useRef(prefs);
  const timer = useRef<number | undefined>(undefined);
  const update = (patch: Partial<SharePrefs>) => {
    const next = { ...current.current, ...patch };
    current.current = next;
    setPrefs(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void api.setSetting(SHARE_KEY, next).catch(fail), 350);
  };
  return [prefs, update];
}

/** Insights on the left, the share card on the right. Everything on the card is chosen here. */
export function RecapsView() {
  const range = useHub((s) => s.recapRange);
  const filter = useHub((s) => s.recapProjects);
  const projects = useHub((s) => s.data.projects);
  const { recap, error, refresh } = useRecap(range, filter);
  const [prefs, updatePrefs] = usePrefs();
  const [draft, setDraft] = useState<ShareDraft>(EMPTY_DRAFT);
  const [outcomeText, setOutcomeText] = useState("");
  const outcomeInput = useRef<HTMLInputElement>(null);

  // A different period or project set is a different recap: nothing of yours is on it until you tick it.
  useEffect(() => setDraft((d) => ({ ...d, outcomeIds: [] })), [range, filter]);

  const card = useMemo(() => (recap ? buildCard(recap, range, prefs, draft) : null), [recap, range, prefs, draft]);
  const toggleProject = (k: string) => setState({ recapProjects: filter.includes(k) ? filter.filter((x) => x !== k) : [...filter, k] });

  return (
    <section className="panel fade-in absolute top-[52px] right-3 bottom-3 left-3 z-10 flex flex-col overflow-hidden rounded-[12px]" onPointerDown={(e) => e.stopPropagation()}>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <Segmented label="Period" value={range} options={RANGES.map((r) => ({ key: r.key, label: r.label }))} onChange={(k) => setState({ recapRange: k })} />
        <MultiSelect
          label={filter.length ? "Projects" : "All projects"}
          selected={filter}
          onToggle={toggleProject}
          onClear={() => setState({ recapProjects: [] })}
          width={240}
          options={[
            ...projects.map((p) => ({ key: p.id, label: p.archivedAt ? `${p.name} (archived)` : p.name, mark: <span className="h-2 w-2 rounded-full border" style={{ borderColor: p.color ?? "#f1ead8" }} /> })),
            { key: UNSORTED, label: "Unsorted" },
          ]}
        />
        {recap && recap.days.length > 0 && <span className="text-[11.5px] text-ink-3">{periodLabel(recap.days[0].date, recap.days[recap.days.length - 1].date)}</span>}
        {recap?.projects.some((p) => p.isDemo) && <span className="rounded-[5px] border border-line px-1.5 py-[1px] text-[10.5px] text-ink-3">Includes demo data</span>}
      </div>

      {error && <div className="px-4 py-3 text-[12.5px] text-danger">{error.message}</div>}
      {!recap && !error && <div className="px-4 py-10 text-center text-[12.5px] text-ink-3">Reading the index…</div>}
      {recap && card && (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_468px]">
          <div className="min-h-0 overflow-y-auto px-5 py-4">
            <Insights recap={recap} />
            <OutcomesSection
              recap={recap}
              range={range}
              filter={filter}
              draft={draft}
              setDraft={setDraft}
              format={prefs.format}
              text={outcomeText}
              setText={setOutcomeText}
              inputRef={outcomeInput}
              onChange={refresh}
            />
            <ProjectsSection recap={recap} prefs={prefs} updatePrefs={updatePrefs} />
            <PullRequestsSection
              recap={recap}
              onDraft={(n) => {
                setOutcomeText(n ? `Pull request #${n}: ` : "Pull request: ");
                outcomeInput.current?.focus();
              }}
            />
          </div>
          <SharePane recap={recap} card={card} prefs={prefs} updatePrefs={updatePrefs} draft={draft} setDraft={setDraft} />
        </div>
      )}
    </section>
  );
}

// ───────────── insights ─────────────

function Section({ title, tag, hint, children, right }: { title: string; tag?: ReactNode; hint?: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="mt-6 first:mt-0">
      <div className="mb-2 flex items-baseline gap-2">
        <h2 className="eyebrow">{title}</h2>
        {tag}
        <div className="flex-1" />
        {right}
      </div>
      {hint && <p className="mb-2.5 max-w-[640px] text-[11.5px] leading-[1.5] text-ink-3">{hint}</p>}
      {children}
    </section>
  );
}

function Tag({ tone = "observed", children, title }: { tone?: "observed" | "yours"; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={`rounded-[5px] border px-1.5 py-[1px] text-[10px] font-medium ${tone === "yours" ? "border-star/30 text-star-dim" : "border-line-strong text-ink-3"}`}>
      {children}
    </span>
  );
}

function Tile({ value, label, sub, title }: { value: number | string; label: string; sub?: string; title?: string }) {
  return (
    <div className="rounded-[10px] border border-line bg-white/[0.02] px-3.5 py-3" title={title}>
      <div className="text-[24px] leading-none font-semibold text-ink tabular-nums">{typeof value === "number" ? value.toLocaleString() : value}</div>
      <div className="mt-1.5 text-[11.5px] text-ink-2">{label}</div>
      {sub && <div className="mt-0.5 text-[11px] text-ink-4">{sub}</div>}
    </div>
  );
}

function Insights({ recap }: { recap: Recap }) {
  const t = recap.totals;
  const c = recap.coverage;
  return (
    <Section title="Activity" tag={<Tag title="From provider timestamps and Hoku's runtime history">Observed</Tag>}>
      <div className="grid grid-cols-4 gap-2.5">
        <Tile value={t.projects} label={t.projects === 1 ? "Active project" : "Active projects"} sub="Named projects only" />
        <Tile value={t.sessions} label={t.sessions === 1 ? "Session" : "Sessions"} sub={`${t.observedSessions.toLocaleString()} seen live by Hoku`} />
        <Tile value={`${t.activeDays}`} label="Active days" sub={`of ${c.rangeDays} in this period`} />
        <Tile
          value={t.readyTransitions}
          label="Turns handed back"
          sub="Observed Ready, not tasks done"
          title="Working → Ready transitions recorded while Hoku was open. A finished turn, never a finished task."
        />
      </div>
      <p className="mt-2 text-[11.5px] text-ink-3">
        Observed while Hoku was open: {t.workStarts.toLocaleString()} {t.workStarts === 1 ? "turn" : "turns"} started, {t.inputRequests.toLocaleString()} {t.inputRequests === 1 ? "request" : "requests"} for your input.
      </p>

      <DayChart recap={recap} />
      <ProviderMix recap={recap} />

      <div className="mt-3 rounded-[9px] border border-line bg-white/[0.015] px-3 py-2.5 text-[11.5px] leading-[1.55] text-ink-3">
        <span className="font-medium text-ink-2">Coverage. </span>
        {coverageSentences(recap).join(" ")}
      </div>
    </Section>
  );
}

function DayChart({ recap }: { recap: Recap }) {
  const days = recap.days;
  if (days.length < 2) return null;
  const max = Math.max(1, ...days.map((d) => d.sessions));
  return (
    <div className="mt-4">
      <div className="flex h-[56px] items-end" style={{ gap: days.length <= 14 ? 10 : 3 }} role="img" aria-label={`Active sessions per day, ${days.length} days. Busiest day: ${max} sessions.`}>
        {days.map((d) => (
          <div
            key={d.date}
            title={`${shortDay(d.date)} · ${d.sessions} ${d.sessions === 1 ? "session" : "sessions"}${d.observed ? " · runtime observed" : " · no runtime history that day"}`}
            className="flex-1 rounded-[2px]"
            style={{
              height: d.sessions ? `${Math.max(8, Math.sqrt(d.sessions / max) * 100)}%` : 2,
              background: d.sessions ? `rgb(241 234 216 / ${d.observed ? 0.72 : 0.3})` : "rgb(241 234 216 / 0.08)",
            }}
          />
        ))}
      </div>
      <div className="mt-1.5 flex items-center gap-3 text-[10.5px] text-ink-4">
        <span>{shortDay(days[0].date)}</span>
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-[2px] bg-star/70" /> runtime observed
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-[2px] bg-star/30" /> provider timestamps only
        </span>
        <span className="flex-1" />
        <span>{shortDay(days[days.length - 1].date)}</span>
      </div>
    </div>
  );
}

function ProviderMix({ recap }: { recap: Recap }) {
  const total = recap.providers.reduce((n, p) => n + p.sessions, 0);
  if (!total) return null;
  return (
    <div className="mt-4">
      <div className="flex h-[6px] gap-[3px] overflow-hidden rounded-full">
        {recap.providers.map((p) => (
          <div key={p.provider} style={{ flex: p.sessions, background: PROVIDERS[p.provider].accent }} />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-ink-2">
        {recap.providers.map((p) => (
          <span key={p.provider} className="flex items-center gap-1.5">
            <GlyphIcon kind={PROVIDERS[p.provider].glyph} color={PROVIDERS[p.provider].accent} size={9} />
            {PROVIDERS[p.provider].label}
            <span className="text-ink-4 tabular-nums">{p.sessions}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

// ───────────── outcomes ─────────────

function OutcomesSection({
  recap,
  range,
  filter,
  draft,
  setDraft,
  format,
  text,
  setText,
  inputRef,
  onChange,
}: {
  recap: Recap;
  range: RecapRange;
  filter: string[];
  draft: ShareDraft;
  setDraft: (f: (d: ShareDraft) => ShareDraft) => void;
  format: CardFormat;
  text: string;
  setText: (t: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onChange: () => void;
}) {
  const projects = useHub((s) => s.data.projects);
  const today = dayKey(new Date());
  const first = recap.days[0]?.date ?? today;
  const [day, setDay] = useState(today);
  const [project, setProject] = useState<string>("");
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const max = MAX_CARD_OUTCOMES[format];
  const onCard = new Set(pickOutcomes(recap.outcomes, draft, format).map((o) => o.id));
  const names = new Map(projects.map((p) => [p.id, p.name]));

  // New outcomes default to the one project being recapped, if there is one.
  useEffect(() => setProject(filter.length === 1 && filter[0] !== UNSORTED ? filter[0] : ""), [filter]);
  useEffect(() => setDay((d) => (d < first ? first : d)), [first, range]);

  const toggle = (id: string) =>
    setDraft((d) => {
      const current = pickOutcomes(recap.outcomes, d, format).map((o) => o.id);
      return { ...d, outcomeIds: current.includes(id) ? current.filter((x) => x !== id) : [...current, id] };
    });

  const add = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      // Writing an outcome doesn't put it on the card; ticking it does.
      await api.createOutcome({ text, occurredOn: day, projectId: project || null });
      setText("");
      onChange();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (o: Outcome) => {
    try {
      await api.deleteOutcome(o.id);
      onChange();
      toast({
        tone: "info",
        message: "Outcome removed",
        action: {
          label: "Undo",
          run: () => void api.createOutcome({ text: o.text, occurredOn: o.occurredOn, projectId: o.projectId ?? null }).then(onChange, fail),
        },
      });
    } catch (e) {
      fail(e);
    }
  };

  return (
    <Section
      title="Outcomes"
      tag={<Tag tone="yours">Written by you</Tag>}
      right={
        recap.outcomes.length > 0 && (
          <span className="text-[11px] text-ink-4 tabular-nums">
            {onCard.size} of {max} on the card
          </span>
        )
      }
      hint={
        <>
          What actually moved forward: shipped, decided, unblocked, learned. Hoku never marks work as done. A session being Ready only means a turn finished. Outcomes stay off the card and the
          post text until you tick them, up to {max} in this format.
        </>
      }
    >
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <div className="relative min-w-0 flex-1">
          <input
            ref={inputRef}
            className="field pr-12"
            placeholder="e.g. Shipped the CSV importer to beta"
            value={text}
            maxLength={OUTCOME_MAX}
            onChange={(e) => setText(e.target.value)}
            aria-label="New outcome"
          />
          <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-[10.5px] text-ink-4 tabular-nums">{OUTCOME_MAX - text.length}</span>
        </div>
        <input type="date" className="field w-[136px]" value={day} min={first} max={today} onChange={(e) => setDay(e.target.value || today)} aria-label="Outcome date" />
        <select className="field w-[150px]" value={project} onChange={(e) => setProject(e.target.value)} aria-label="Outcome project">
          <option value="">No project</option>
          {projects
            .filter((p) => !p.archivedAt || p.id === project)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
        </select>
        <button type="submit" className="btn btn-primary" disabled={!text.trim() || busy}>
          Add
        </button>
      </form>

      {recap.outcomes.length === 0 ? (
        <p className="mt-3 text-[12px] text-ink-4">No outcomes in this period yet. Without ticked outcomes the card shows activity only.</p>
      ) : (
        <ul className="mt-3 divide-y divide-white/[0.04] rounded-[10px] border border-line">
          {recap.outcomes.map((o) =>
            editing === o.id ? (
              <OutcomeEditor key={o.id} outcome={o} first={first} today={today} onDone={() => (setEditing(null), onChange())} />
            ) : (
              <li key={o.id} className="group flex items-center gap-3 px-3 py-2">
                <label className="flex min-w-0 flex-1 items-center gap-2.5">
                  <input
                    type="checkbox"
                    checked={onCard.has(o.id)}
                    disabled={!onCard.has(o.id) && onCard.size >= max}
                    onChange={() => toggle(o.id)}
                    aria-label={`Show “${o.text}” on the card`}
                  />
                  <span className={`min-w-0 flex-1 text-[12.5px] ${onCard.has(o.id) ? "text-ink" : "text-ink-3"}`}>{o.text}</span>
                </label>
                {o.projectId && <span className="max-w-[140px] shrink-0 truncate text-[11px] text-ink-3">{names.get(o.projectId) ?? ""}</span>}
                <span className="w-[48px] shrink-0 text-right text-[11px] text-ink-4 tabular-nums">{shortDay(o.occurredOn)}</span>
                <button className="btn btn-ghost h-6 w-6 justify-center px-0 text-ink-4 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100" onClick={() => setEditing(o.id)} aria-label="Edit outcome" title="Edit">
                  <IconEdit size={13} />
                </button>
                <button className="btn btn-ghost h-6 w-6 justify-center px-0 text-ink-4 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100" onClick={() => void remove(o)} aria-label="Delete outcome" title="Delete">
                  <IconTrash size={13} />
                </button>
              </li>
            ),
          )}
        </ul>
      )}
    </Section>
  );
}

function OutcomeEditor({ outcome, first, today, onDone }: { outcome: Outcome; first: string; today: string; onDone: () => void }) {
  const [text, setText] = useState(outcome.text);
  const [day, setDay] = useState(outcome.occurredOn);
  const save = async () => {
    try {
      await api.updateOutcome(outcome.id, { text, occurredOn: day, projectId: outcome.projectId ?? null });
      onDone();
    } catch (e) {
      fail(e);
    }
  };
  return (
    <li className="flex items-center gap-2 px-3 py-2">
      <input
        className="field min-w-0 flex-1"
        value={text}
        maxLength={OUTCOME_MAX}
        autoFocus
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void save();
          if (e.key === "Escape") {
            e.stopPropagation();
            onDone();
          }
        }}
        aria-label="Outcome"
      />
      <input type="date" className="field w-[136px]" value={day} min={first < day ? first : day} max={today} onChange={(e) => setDay(e.target.value || day)} aria-label="Outcome date" />
      <button className="btn btn-primary" onClick={() => void save()} disabled={!text.trim()}>
        Save
      </button>
      <button className="btn btn-ghost" onClick={onDone}>
        Cancel
      </button>
    </li>
  );
}

// ───────────── projects ─────────────

function ProjectsSection({ recap, prefs, updatePrefs }: { recap: Recap; prefs: SharePrefs; updatePrefs: (p: Partial<SharePrefs>) => void }) {
  if (!recap.projects.length) return null;
  const setLabel = (p: RecapProject, label: string | null) => {
    const next = { ...prefs.projectLabels };
    if (label === null) delete next[p.key];
    else next[p.key] = label;
    updatePrefs({ projectLabels: next });
  };
  return (
    <Section title="Projects" tag={<Tag>Observed</Tag>} hint="Project names stay off the card unless you name them here. You can use a public name instead of the real one. Unnamed projects are drawn as unlabeled stars.">
      <div className="rounded-[10px] border border-line">
        <div className="grid grid-cols-[minmax(0,1fr)_64px_64px_72px_52px_minmax(0,210px)] gap-3 border-b border-line px-3 py-2 text-[11px] font-medium text-ink-3">
          <span>Project</span>
          <span className="text-right">Sessions</span>
          <span className="text-right">Days</span>
          <span className="text-right" title="Observed Ready transitions: finished turns, not finished tasks">Handed back</span>
          <span className="text-right">PRs</span>
          <span>Name on card</span>
        </div>
        {recap.projects.map((p) => {
          const label = prefs.projectLabels[p.key];
          const named = label !== undefined;
          return (
            <div key={p.key} className="grid grid-cols-[minmax(0,1fr)_64px_64px_72px_52px_minmax(0,210px)] items-center gap-3 border-b border-white/[0.03] px-3 py-[7px] text-[12.5px] last:border-0">
              <span className="flex min-w-0 items-center gap-2">
                <span className="h-2 w-2 shrink-0 rounded-full border" style={{ borderColor: p.color ?? "#f1ead8", borderStyle: p.key === UNSORTED ? "dashed" : "solid" }} />
                <span className="truncate text-ink">{p.name}</span>
                {p.archived && <span className="text-[10.5px] text-ink-4">archived</span>}
                <span className="flex shrink-0 items-center gap-1">
                  {p.providers.map((x) => (
                    <GlyphIcon key={x.provider} kind={PROVIDERS[x.provider].glyph} color={PROVIDERS[x.provider].accent} size={8} />
                  ))}
                </span>
              </span>
              <span className="text-right text-ink-2 tabular-nums">{p.sessions}</span>
              <span className="text-right text-ink-2 tabular-nums">{p.activeDays}</span>
              <span className="text-right text-ink-2 tabular-nums">{p.readyTransitions}</span>
              <span className="text-right text-ink-2 tabular-nums">{p.pullRequests || "–"}</span>
              {p.key === UNSORTED ? (
                <span className="text-[11px] text-ink-4">Never named</span>
              ) : (
                <span className="flex min-w-0 items-center gap-2">
                  <input type="checkbox" checked={named} onChange={() => setLabel(p, named ? null : p.name)} aria-label={`Name ${p.name} on the card`} />
                  {named ? (
                    <input className="field h-[24px] min-w-0 flex-1 px-2 py-0 text-[12px]" value={label} maxLength={40} onChange={(e) => setLabel(p, e.target.value)} aria-label={`Public name for ${p.name}`} />
                  ) : (
                    <span className="text-[11.5px] text-ink-4">Unnamed</span>
                  )}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </Section>
  );
}

// ───────────── pull requests ─────────────

function PullRequestsSection({ recap, onDraft }: { recap: Recap; onDraft: (n: number | null) => void }) {
  const names = new Map(recap.projects.map((p) => [p.key, p.name]));
  if (!recap.pullRequests.length) return null;
  return (
    <Section title="Linked pull requests" tag={<Tag>Observed</Tag>} hint="Pull requests linked in Claude Code sessions active in this period. Hoku doesn't know whether they merged, and links never go on the card. Turn one into an outcome in your own words.">
      <ul className="divide-y divide-white/[0.04] rounded-[10px] border border-line">
        {recap.pullRequests.map((pr) => (
          <li key={pr.url} className="flex items-center gap-3 px-3 py-[7px] text-[12.5px]">
            <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-2" title={pr.url}>
              {pr.repo ?? pr.url}
              {pr.number != null && <span className="text-ink"> #{pr.number}</span>}
            </span>
            <span className="max-w-[160px] shrink-0 truncate text-[11px] text-ink-3">{names.get(pr.projectKey)}</span>
            <span className="w-[64px] shrink-0 text-right text-[11px] text-ink-4">{relativeTime(pr.lastActivityAt)}</span>
            <button className="btn btn-ghost h-6 px-2 text-[11.5px]" onClick={() => onDraft(pr.number ?? null)}>
              Draft outcome
            </button>
          </li>
        ))}
      </ul>
    </Section>
  );
}

// ───────────── share ─────────────

function Segmented<K extends string>({ label, value, options, onChange }: { label: string; value: K; options: { key: K; label: string; title?: string }[]; onChange: (k: K) => void }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex h-[26px] items-center rounded-[7px] border border-line bg-white/[0.02] p-[2px]">
      {options.map((o) => {
        const on = o.key === value;
        return (
          <button
            key={o.key}
            role="radio"
            aria-checked={on}
            title={o.title}
            className={`h-full rounded-[5px] px-2 text-[11.5px] whitespace-nowrap transition-colors ${on ? "bg-white/[0.08] text-ink" : "text-ink-3 hover:text-ink-2"}`}
            onClick={() => onChange(o.key)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function Check({ checked, onChange, children, hint }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; hint?: string }) {
  return (
    <label className="flex items-center gap-2 py-[3px] text-[12px] text-ink-2" title={hint}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  );
}

/** Screen readers get the card as text: the same words the image carries. */
export function cardAltText(c: CardContent): string {
  return [c.period, c.headline, ...c.outcomes, c.stats.map((s) => `${s.value} ${s.label}`).join(", "), c.providers.map((p) => p.label).join(", "), c.footnote, c.attribution ?? ""].filter(Boolean).join(". ");
}

function CardPreview({ card }: { card: CardContent }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [mark, setMark] = useState<HTMLImageElement | null>(null);
  useEffect(() => void loadMark().then(setMark), []);
  const { width, height } = FORMATS[card.format];
  // Fit 436 × 460: landscape and square by width, portrait by height.
  const cssW = Math.min(436, (460 * width) / height);
  const cssH = (cssW * height) / width;
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const scale = (cssW / width) * (window.devicePixelRatio || 1);
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    drawCard(ctx, card, scale, mark);
  }, [card, mark, cssW, width, height]);
  return (
    <div className="flex justify-center">
      <canvas ref={ref} role="img" aria-label={cardAltText(card)} className="rounded-[10px] shadow-[0_0_0_1px_rgb(255_255_255/0.08),0_18px_40px_-16px_rgb(0_0_0/0.8)]" style={{ width: cssW, height: cssH }} />
    </div>
  );
}

function SharePane({
  recap,
  card,
  prefs,
  updatePrefs,
  draft,
  setDraft,
}: {
  recap: Recap;
  card: CardContent;
  prefs: SharePrefs;
  updatePrefs: (p: Partial<SharePrefs>) => void;
  draft: ShareDraft;
  setDraft: (f: (d: ShareDraft) => ShareDraft) => void;
}) {
  const [busy, setBusy] = useState<"save" | "copy" | null>(null);
  const [tab, setTab] = useState<"linkedin" | "chat">("linkedin");
  const [edited, setEdited] = useState<{ linkedin: string | null; chat: string | null }>({ linkedin: null, chat: null });
  const generated = tab === "linkedin" ? linkedInText(card) : chatText(card);
  const text = edited[tab] ?? generated;
  const empty = recap.totals.sessions === 0 && card.outcomes.length === 0;

  const exportImage = async (how: "save" | "copy") => {
    setBusy(how);
    try {
      const png = await renderPng(card);
      if (how === "save") {
        const path = await api.saveRecapImage(png);
        toast({ tone: "success", message: `Saved ${path.split("/").pop()} to Downloads`, action: { label: "Show in Finder", run: () => void reveal(path) } });
      } else {
        await api.copyRecapImage(png);
        toast({ tone: "success", message: "Image copied. Paste it into your post or chat." });
      }
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  const stat = (k: StatKey) => (
    <Check key={k} checked={prefs.stats[k]} onChange={(v) => updatePrefs({ stats: { ...prefs.stats, [k]: v } })} hint={STAT_LABELS[k].hint}>
      {STAT_LABELS[k].label}
    </Check>
  );

  return (
    <aside className="min-h-0 overflow-y-auto border-l border-line bg-black/10 px-4 py-4" aria-label="Share card">
      <div className="mb-2.5 flex items-center justify-between">
        <h2 className="eyebrow">Share card</h2>
        <Segmented label="Card format" value={prefs.format} options={(Object.keys(FORMATS) as CardFormat[]).map((k) => ({ key: k, label: FORMATS[k].label, title: FORMATS[k].hint }))} onChange={(k) => updatePrefs({ format: k })} />
      </div>
      <CardPreview card={card} />
      <p className="mt-1.5 text-center text-[10.5px] text-ink-4">{FORMATS[prefs.format].hint} · exported at 2×</p>

      <div className="mt-3 flex gap-2">
        <button className="btn btn-primary flex-1 justify-center" disabled={empty || busy !== null} onClick={() => void exportImage("copy")}>
          <IconCopy size={13} /> {busy === "copy" ? "Copying…" : "Copy image"}
        </button>
        <button className="btn flex-1 justify-center" disabled={empty || busy !== null} onClick={() => void exportImage("save")}>
          <IconDownload size={13} /> {busy === "save" ? "Saving…" : "Save PNG"}
        </button>
      </div>
      {empty && <p className="mt-2 text-[11.5px] text-ink-4">Nothing to share for this period yet.</p>}

      <div className="mt-5">
        <label className="mb-1 block text-[11.5px] font-medium text-ink-2" htmlFor="recap-headline">
          Headline
        </label>
        <input
          id="recap-headline"
          className="field"
          value={draft.headline}
          maxLength={80}
          placeholder={card.headline}
          onChange={(e) => {
            const headline = e.target.value;
            setDraft((d) => ({ ...d, headline }));
          }}
        />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-x-3">
        <div>
          <div className="mb-1 text-[11.5px] font-medium text-ink-2">Numbers</div>
          {(Object.keys(STAT_LABELS) as StatKey[]).map(stat)}
        </div>
        <div>
          <div className="mb-1 text-[11.5px] font-medium text-ink-2">Also show</div>
          <Check checked={prefs.providers} onChange={(v) => updatePrefs({ providers: v })}>
            Provider mix
          </Check>
          <Check checked={prefs.activity} onChange={(v) => updatePrefs({ activity: v })} hint="Relative sessions per day; brighter days are ones Hoku observed live">
            Daily rhythm
          </Check>
          <Check checked={prefs.attribution} onChange={(v) => updatePrefs({ attribution: v })}>
            “Recapped with Hoku”
          </Check>
          <Check checked={prefs.link} onChange={(v) => updatePrefs({ link: v })} hint="Adds github.com/joao-afonso-p/hoku">
            Link to Hoku
          </Check>
        </div>
      </div>

      <div className="mt-4 rounded-[9px] border border-line bg-white/[0.015] px-3 py-2.5 text-[11px] leading-[1.55] text-ink-3">
        <div className="flex items-center gap-1.5 font-medium text-ink-2">
          <IconCheck size={12} className="text-ok" /> Public-safe by default
        </div>
        Only what you see above goes out. Never included: account names or emails, session titles or IDs, file paths, prompts, runtime details, notes, PR links, or project names you haven't named.
        Nothing is uploaded: you copy or save, and you post.
      </div>

      <div className="mt-5">
        <div className="mb-1.5 flex items-center justify-between">
          <Segmented
            label="Post text"
            value={tab}
            options={[
              { key: "linkedin", label: "LinkedIn post" },
              { key: "chat", label: "Slack / Teams" },
            ]}
            onChange={setTab}
          />
          {edited[tab] !== null && (
            <button className="text-[11px] text-ink-3 hover:text-ink-2" onClick={() => setEdited((e) => ({ ...e, [tab]: null }))}>
              Edited · reset to card
            </button>
          )}
        </div>
        <textarea
          className="field h-[180px] resize-none font-sans text-[12.5px] leading-[1.5]"
          value={text}
          onChange={(e) => {
            const v = e.target.value;
            setEdited((x) => ({ ...x, [tab]: v }));
          }}
          aria-label={tab === "linkedin" ? "LinkedIn post text" : "Slack or Teams message text"}
          spellCheck
        />
        <div className="mt-1.5 flex items-center justify-between">
          <span className="text-[10.5px] text-ink-4 tabular-nums">{tab === "linkedin" ? `${text.length.toLocaleString()} / 3,000` : `${text.length.toLocaleString()} characters`}</span>
          <button className="btn" disabled={!text.trim()} onClick={() => void copy(text, tab === "linkedin" ? "Post text" : "Message")}>
            <IconCopy size={13} /> Copy text
          </button>
        </div>
      </div>
    </aside>
  );
}
