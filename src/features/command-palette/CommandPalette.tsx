import { useEffect, useMemo, useRef, useState } from "react";
import { closeOverlay, copy, focusProject, openOverlay, openRecaps, openResume, openSession, quickFilter, revealSession, scan, setStatusFilter, showSessions, toggleFavorite, toggleFollowUp, toggleList } from "../../app/actions";
import { UNSORTED } from "../../app/model";
import { getState, useHub } from "../../app/store";
import { basename } from "../../lib/paths";
import { relativeTime } from "../../lib/time";
import type { Project, Session } from "../../lib/types";
import { PROVIDERS, surfaceLabel } from "../../providers";
import { GlyphIcon } from "../constellation/Glyph";
import { IconFlagFilled, IconSearch } from "../../components/Icons";
import { search, type SearchDoc } from "./search";
import { isActive, needsYou, reasonText, STATUS, stateSince, statusKey } from "../runtime/status";
import { StatusDot } from "../runtime/StatusMark";

type Item =
  | { kind: "session"; id: string; session: Session; project: Project | null }
  | { kind: "project"; id: string; project: Project; count: number }
  | { kind: "action"; id: string; label: string; hint?: string; run: () => void; keywords: string };

const ACTIONS: Omit<Extract<Item, { kind: "action" }>, "kind">[] = [
  { id: "a:scan", label: "Scan for sessions", hint: "Claude Code · Codex · Cowork", keywords: "scan discover refresh index", run: () => void scan() },
  { id: "a:add-session", label: "Add session manually", hint: "Claude link, Codex thread, Claude Code ID", keywords: "add new session conversation link manual", run: () => openOverlay({ kind: "add-session" }) },
  { id: "a:add-project", label: "Add project", keywords: "new project create", run: () => openOverlay({ kind: "project" }) },
  { id: "a:integrations", label: "Open Integrations", keywords: "integrations providers accounts status connect", run: () => openOverlay({ kind: "integrations" }) },
  { id: "a:needs", label: "Show Needs You", hint: "Sessions waiting on you", keywords: "needs you inbox waiting permission approval question attention", run: () => toggleList("needs") },
  { id: "a:follow", label: "Show Follow up", hint: "Sessions you want to review later", keywords: "follow up review later reminder snooze queue todo due overdue", run: () => toggleList("follow") },
  { id: "a:activity", label: "Show Activity", hint: "Cross-provider timeline", keywords: "activity timeline recent history events finished", run: () => toggleList("activity") },
  { id: "a:sessions", label: "Show Sessions", hint: "Sortable, filterable list", keywords: "sessions list table manage filter", run: () => showSessions() },
  { id: "a:recaps", label: "Show Recaps", hint: "Shareable project and work recap", keywords: "recap insights analytics share linkedin slack teams summary week month outcomes", run: () => openRecaps() },
  { id: "a:filter-needs", label: "Filter Galaxy: Needs You", keywords: "filter galaxy needs you waiting status", run: () => quickFilter("needs_you") },
  { id: "a:filter-working", label: "Filter Galaxy: Working", keywords: "filter galaxy working active running live status", run: () => quickFilter("working") },
  { id: "a:filter-clear", label: "Clear status filter", keywords: "clear filter status reset all", run: () => setStatusFilter([]) },
  { id: "a:favorites", label: "Show favorites", keywords: "favorites starred pinned", run: () => toggleList("favorites") },
  {
    id: "a:resume",
    label: "Resume this project",
    hint: "What it is, what changed, what needs you, where to continue",
    keywords: "resume project summary description next step continue recap",
    run: () => {
      const f = getState().focus;
      if (f && f !== UNSORTED) openResume(f);
      else toggleList("projects");
    },
  },
  { id: "a:galaxy", label: "Back to galaxy", keywords: "galaxy home all overview", run: () => focusProject(null) },
  { id: "a:settings", label: "Settings", keywords: "settings preferences terminal iterm", run: () => openOverlay({ kind: "settings" }) },
];

export function CommandPalette() {
  const sessions = useHub((s) => s.data.sessions);
  const projects = useHub((s) => s.data.projects);
  const accounts = useHub((s) => s.data.accounts);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const accountById = useMemo(() => new Map(accounts.map((a) => [a.id, a.label])), [accounts]);

  const docs = useMemo(() => {
    const out: (SearchDoc & { item: Item })[] = [];
    for (const s of sessions) {
      const project = s.projectId ? (projectById.get(s.projectId) ?? null) : null;
      out.push({
        id: s.id,
        item: { kind: "session", id: s.id, session: s, project },
        fields: [
          { text: s.title, weight: 1.25 },
          { text: project?.name ?? "unsorted", weight: 1.1 },
          { text: `${surfaceLabel(s)} ${PROVIDERS[s.provider].label}`, weight: 0.8 },
          { text: s.notes ?? "", weight: 0.9 },
          { text: s.branch ?? "", weight: 0.7 },
          { text: basename(s.workingDirectory) + " " + (s.workingDirectory ?? ""), weight: 0.6 },
          { text: accountById.get(s.providerAccountId ?? "") ?? "", weight: 0.5 },
          { text: String(s.metadata?.firstPrompt ?? ""), weight: 0.35 },
          // Lets "working" or "needs you" find sessions in that state.
          { text: `${STATUS[statusKey(s)].label} ${s.runtime.reason ?? ""}`, weight: 0.5 },
          { text: s.followUp ? "follow up review later" : "", weight: 0.5 },
        ],
        lastActivityAt: s.lastActivityAt,
        lastOpenedAt: s.lastOpenedAt,
        active: isActive(s),
        attention: needsYou(s),
        favorite: s.favorite,
      });
    }
    for (const p of projects) {
      const count = sessions.filter((s) => s.projectId === p.id).length;
      out.push({
        id: "p:" + p.id,
        item: { kind: "project", id: "p:" + p.id, project: p, count },
        fields: [
          { text: p.name, weight: 1.3 },
          { text: "project " + (p.rootPath ?? ""), weight: 0.5 },
        ],
      });
    }
    for (const a of ACTIONS) {
      out.push({ id: a.id, item: { kind: "action", ...a }, fields: [{ text: a.label, weight: 1 }, { text: a.keywords, weight: 0.8 }] });
    }
    return out;
  }, [sessions, projects, projectById, accountById]);

  const items: Item[] = useMemo(() => {
    const byId = new Map(docs.map((d) => [d.id, d.item]));
    if (!query.trim()) {
      // Empty query: live and recent sessions, then projects, then actions.
      const sessionDocs = docs.filter((d) => d.item.kind === "session");
      const ranked = search("", sessionDocs).slice(0, 8).map((h) => byId.get(h.id)!);
      return [...ranked, ...ACTIONS.slice(0, 3).map((a) => byId.get(a.id)!)];
    }
    const hits = search(query, docs, Date.now(), 40).map((h) => byId.get(h.id)!);
    // Keep actions from crowding out sessions.
    const s = hits.filter((i) => i.kind !== "action");
    const a = hits.filter((i) => i.kind === "action").slice(0, 3);
    return [...s.slice(0, 30), ...a];
  }, [docs, query]);

  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const run = (item: Item | undefined, mode: "open" | "reveal" | "state" | "project" = "open") => {
    if (!item) return;
    closeOverlay();
    if (item.kind === "session") {
      if (mode === "reveal") revealSession(item.session);
      else if (mode === "state") setStatusFilter([statusKey(item.session)]);
      else if (mode === "project") {
        if (item.project?.archivedAt) openOverlay({ kind: "project", projectId: item.project.id });
        else focusProject(item.session.projectId && item.project ? item.session.projectId : UNSORTED);
      } else void openSession(item.session);
    } else if (item.kind === "project") {
      // Archived projects aren't on the map; open them where they can be restored.
      if (item.project.archivedAt) openOverlay({ kind: "project", projectId: item.project.id });
      else focusProject(item.project.id);
    }
    else item.run();
  };

  const onKey = (e: React.KeyboardEvent) => {
    const current = items[index];
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
      e.preventDefault();
      setIndex((i) => Math.min(items.length - 1, i + 1));
    } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
      e.preventDefault();
      setIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(current, e.metaKey ? "reveal" : e.altKey ? "state" : "open");
    } else if (e.key.toLowerCase() === "p" && e.metaKey && current?.kind === "session") {
      e.preventDefault();
      run(current, "project");
    } else if (e.key.toLowerCase() === "d" && e.metaKey && current?.kind === "session") {
      e.preventDefault();
      void toggleFavorite(current.session);
    } else if (e.key.toLowerCase() === "f" && e.metaKey && current?.kind === "session") {
      e.preventDefault();
      void toggleFollowUp(current.session);
    } else if (e.key === "c" && e.metaKey && current?.kind === "session" && !window.getSelection()?.toString()) {
      e.preventDefault();
      const id = current.session.externalId ?? current.session.id;
      void copy(id, "ID");
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeOverlay();
    }
  };

  const showSections = !query.trim();
  const current = items[index];

  return (
    <div className="absolute inset-0 z-50 flex items-start justify-center bg-black/35 pt-[14vh]" onPointerDown={closeOverlay}>
      <div className="panel w-[620px] max-w-[calc(100vw-48px)] overflow-hidden rounded-[13px]" onPointerDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2.5 border-b border-line px-4">
          <IconSearch className="text-ink-3" />
          <input
            autoFocus
            spellCheck={false}
            className="h-[50px] flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-ink-4"
            placeholder="Search sessions, projects, actions…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
          />
          <span className="kbd">esc</span>
        </div>

        <div ref={listRef} className="max-h-[420px] overflow-y-auto py-1.5">
          {items.length === 0 && <div className="px-4 py-8 text-center text-[12.5px] text-ink-3">Nothing matches “{query}”.</div>}
          {items.map((item, i) => {
            const prev = items[i - 1];
            const header =
              showSections && (!prev || prev.kind !== item.kind) ? (item.kind === "session" ? "Needs you, live & recent" : item.kind === "action" ? "Actions" : "Projects") : null;
            return (
              <div key={item.id}>
                {header && <div className="eyebrow px-4 pt-2.5 pb-1">{header}</div>}
                <Row item={item} active={i === index} index={i} onHover={() => setIndex(i)} onClick={() => run(item)} />
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-4 border-t border-line px-4 py-2 text-[11px] text-ink-3">
          <span className="flex items-center gap-1.5">
            <span className="kbd">↵</span> {current?.kind === "session" ? (current.session.provider === "claude-code" ? "Go to terminal" : "Open") : current?.kind === "project" ? "Enter project" : "Run"}
          </span>
          {current?.kind === "session" && (
            <>
              <span className="flex items-center gap-1.5">
                <span className="kbd">⌘</span>
                <span className="kbd">↵</span> Show on map
              </span>
              <span className="flex items-center gap-1.5">
                <span className="kbd">⌥</span>
                <span className="kbd">↵</span> Filter to {STATUS[statusKey(current.session)].label}
              </span>
              <span className="flex items-center gap-1.5" title="⌘P go to project · ⌘D favorite · ⌘F follow up">
                <span className="kbd">⌘</span>
                <span className="kbd">C</span> Copy ID
              </span>
            </>
          )}
          <span className="ml-auto text-ink-4">{sessions.length} {sessions.length === 1 ? "session" : "sessions"} indexed</span>
        </div>
      </div>
    </div>
  );
}

function Row({ item, active, index, onHover, onClick }: { item: Item; active: boolean; index: number; onHover: () => void; onClick: () => void }) {
  const base = `mx-1.5 flex items-center gap-3 rounded-[8px] px-2.5 ${active ? "bg-white/[0.06]" : ""}`;
  if (item.kind === "session") {
    const s = item.session;
    const p = PROVIDERS[s.provider];
    const key = statusKey(s);
    const meta = STATUS[key];
    const loud = key === "needs_you" || key === "error" || key === "working";
    const since = stateSince(s);
    return (
      <div data-index={index} className={`${base} py-2`} onPointerMove={onHover} onClick={onClick}>
        <div className="flex w-4 justify-center">
          <GlyphIcon kind={p.glyph} color={p.accent} size={11} hollow={s.sourceMissing} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] text-ink">{s.title}</div>
          <div className="truncate text-[11.5px] text-ink-3">
            <span style={{ color: p.accent }}>{surfaceLabel(s)}</span>
            <span className="text-ink-4"> · </span>
            {item.project?.name ?? "Unsorted"}
            {item.project?.archivedAt && <span className="text-ink-4"> (archived)</span>}
            <span className="text-ink-4"> · </span>
            {loud || key === "ready" ? (
              <span style={{ color: loud ? meta.color : undefined }}>
                {meta.label}
                <span className="text-ink-3"> · {key === "needs_you" ? reasonText(s) : relativeTime(since ?? s.lastActivityAt)}</span>
                {key === "needs_you" && since && <span className="text-ink-3"> · {relativeTime(since)}</span>}
              </span>
            ) : (
              <>
                <span className="text-ink-3">{meta.label}</span>
                <span className="text-ink-4"> · </span>
                {relativeTime(s.lastActivityAt)}
              </>
            )}
            {s.branch && <span className="text-ink-4"> · {s.branch}</span>}
          </div>
        </div>
        <StatusDot status={key} size={7} />
        {s.favorite && <span className="text-[11px] text-star-dim">★</span>}
        {s.followUp && (
          <span className="text-ink-3" title="In Follow up">
            <IconFlagFilled size={11} />
          </span>
        )}
      </div>
    );
  }
  if (item.kind === "project") {
    return (
      <div data-index={index} className={`${base} py-2`} onPointerMove={onHover} onClick={onClick}>
        <div className="flex w-4 justify-center">
          <span className="h-2.5 w-2.5 rounded-full border" style={{ borderColor: item.project.color ?? "#f1ead8" }} />
        </div>
        <div className="flex-1 text-[13px] text-ink">
          {item.project.name}
          <span className="ml-2 text-[11.5px] text-ink-3">
            {item.project.archivedAt ? "Archived project" : "Project"} · {item.count} sessions
          </span>
        </div>
      </div>
    );
  }
  return (
    <div data-index={index} className={`${base} py-1.5`} onPointerMove={onHover} onClick={onClick}>
      <div className="flex w-4 justify-center text-ink-3">›</div>
      <div className="flex-1 text-[13px] text-ink-2">
        {item.label}
        {item.hint && <span className="ml-2 text-[11.5px] text-ink-4">{item.hint}</span>}
      </div>
    </div>
  );
}
