import { listen } from "@tauri-apps/api/event";
import { isSessionVisible, visibilityFromSettings, VISIBILITY_KEYS, type GalaxyVisibility } from "../features/galaxy/visibility";
import type { StatusKey } from "../features/runtime/status";
import type { SessionFilter } from "../features/sessions/filter";
import { api, type ProjectPatch, type SessionPatch } from "../lib/api";
import type { HubError, Session } from "../lib/types";
import { getState, setState, type ListMode, type Overlay, type Toast } from "./store";

/** Settings key: when the Activity timeline was last looked at ("N finished since"). */
export const ACTIVITY_SEEN_KEY = "activity.lastSeenAt";

let toastSeq = 0;

export function toast(t: Omit<Toast, "id">, ttl = t.tone === "error" ? 9000 : 3200) {
  const id = ++toastSeq;
  setState((s) => ({ toasts: [...s.toasts.slice(-3), { ...t, id }] }));
  window.setTimeout(() => dismissToast(id), ttl);
}

export function dismissToast(id: number) {
  setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

export function fail(e: unknown) {
  const err = e as HubError;
  toast({ tone: "error", message: err?.message ?? "Something went wrong.", detail: err?.detail });
}

export async function reload() {
  try {
    const data = await api.snapshot();
    setState((s) => ({
      data,
      loaded: true,
      loadError: null,
      // Drop selection/focus that no longer exists.
      selectedId: s.selectedId && data.sessions.some((x) => x.id === s.selectedId) ? s.selectedId : null,
      focus: s.focus && s.focus !== "unsorted" && !data.projects.some((p) => p.id === s.focus && !p.archivedAt) ? null : s.focus,
    }));
  } catch (e) {
    setState({ loaded: true, loadError: e as HubError });
  }
}

// ───────────── navigation ─────────────

export function focusProject(id: string | null) {
  setState((s) => ({ focus: id, list: null, view: "galaxy", expanded: s.expanded === id ? s.expanded : null }));
}

/** Go to the Galaxy; if already there, re-frame all systems. */
export function showGalaxy() {
  const s = getState();
  if (!s.focus && !s.list && s.view === "galaxy") setState({ fitNonce: s.fitNonce + 1 });
  else setState({ focus: null, list: null, expanded: null, view: "galaxy" });
}

export function showSessions() {
  setState((s) => ({ view: s.view === "sessions" && !s.list ? "galaxy" : "sessions", list: null }));
}

/** Recaps take the whole area; the inspector would only cover the share preview. */
export function showRecaps() {
  setState((s) => ({ view: s.view === "recaps" && !s.list ? "galaxy" : "recaps", list: null, selectedId: null }));
}

export function openRecaps() {
  setState({ view: "recaps", list: null, selectedId: null });
}

// ───────────── runtime filters ─────────────

export function setStatusFilter(keys: StatusKey[]) {
  setState({ statusFilter: keys });
}

export function toggleStatus(key: StatusKey) {
  setState((s) => ({ statusFilter: s.statusFilter.includes(key) ? s.statusFilter.filter((k) => k !== key) : [...s.statusFilter, key] }));
}

/** Quick filter (Needs You, Working): on the Galaxy, only that state. Pressing again clears. */
export function quickFilter(key: StatusKey) {
  setState((s) => ({
    statusFilter: s.statusFilter.length === 1 && s.statusFilter[0] === key ? [] : [key],
    view: "galaxy",
    list: s.list === "projects" || s.list === "favorites" ? s.list : null,
  }));
}

export function clearStatusFilter() {
  setState({ statusFilter: [] });
}

export function patchSessionsFilter(patch: Partial<SessionFilter>) {
  setState((s) => ({ sessionsFilter: { ...s.sessionsFilter, ...patch } }));
}

export async function markActivitySeen() {
  try {
    await api.setSetting(ACTIVITY_SEEN_KEY, new Date().toISOString());
    await reload();
  } catch {
    /* cosmetic */
  }
}

/** Show or hide a project's older sessions without switching the whole Galaxy to All. */
export function toggleExpanded(key: string) {
  setState((s) => ({ expanded: s.expanded === key ? null : key }));
}

/** Put a session on the map — even one the current visibility or status filter hides — and select it. */
export function revealSession(session: Session) {
  const s = getState();
  const project = s.data.projects.find((p) => p.id === session.projectId);
  if (project?.archivedAt) {
    setState({ selectedId: session.id });
    toast({ tone: "info", message: `${project.name} is archived, so it isn’t on the map.`, action: { label: "Restore", run: () => void archiveProject(project.id, false) } });
    return;
  }
  const key = project ? project.id : "unsorted";
  const v = visibilityFromSettings(s.data.settings);
  const hidden = !isSessionVisible(session, v);
  setState({ focus: key, list: null, view: "galaxy", statusFilter: [], expanded: hidden ? key : s.expanded === key ? key : null, selectedId: session.id });
}

export async function setVisibility(patch: Partial<GalaxyVisibility>) {
  try {
    for (const [k, value] of Object.entries(patch)) {
      await api.setSetting(VISIBILITY_KEYS[k as keyof GalaxyVisibility], value);
    }
    await reload();
  } catch (e) {
    fail(e);
  }
}

export function select(id: string | null) {
  setState({ selectedId: id });
}

export function openOverlay(o: Overlay) {
  setState({ overlay: o });
}

export function closeOverlay() {
  setState({ overlay: null });
}

export function toggleList(mode: ListMode | null) {
  setState((s) => ({ list: s.list === mode && s.view === "galaxy" ? null : mode, view: "galaxy" }));
}

/** Escape unwinds one layer at a time: overlay → selection → list → Sessions → focus → filter. */
export function escape() {
  const s = getState();
  if (s.overlay) return closeOverlay();
  if (s.selectedId) return select(null);
  if (s.list) return setState({ list: null });
  if (s.view !== "galaxy") return setState({ view: "galaxy" });
  if (s.focus) return focusProject(null);
  if (s.statusFilter.length) return clearStatusFilter();
}

// ───────────── sessions ─────────────

export async function openSession(session: Session) {
  try {
    const r = await api.openSession(session.id);
    if (r.hint === "spaces-setting") openOverlay({ kind: "spaces-help", app: ["VS Code Insiders", "VS Code", "Terminal"].find((a) => r.message.includes(a)) ?? "iTerm" });
    else toast({ tone: "success", message: r.message });
    void reload();
  } catch (e) {
    // No "open another copy" escape hatch: two processes on one live session conflict.
    fail(e);
  }
}

export async function patchSession(id: string, patch: SessionPatch, quiet = false) {
  try {
    await api.updateSession(id, patch);
    await reload();
    if (!quiet) toast({ tone: "success", message: "Saved" });
  } catch (e) {
    fail(e);
  }
}

export async function toggleFavorite(s: Session) {
  await patchSession(s.id, { favorite: !s.favorite }, true);
}

export async function removeSession(s: Session) {
  try {
    await api.deleteSession(s.id);
    select(null);
    await reload();
    toast({
      tone: "info",
      message: s.discovery === "scan" ? "Removed. It will return on the next scan." : "Session removed",
    });
  } catch (e) {
    fail(e);
  }
}

export async function copy(text: string, what: string) {
  try {
    await api.copyText(text);
    toast({ tone: "success", message: `${what} copied` });
  } catch (e) {
    fail(e);
  }
}

export async function reveal(path: string) {
  try {
    await api.revealPath(path);
  } catch (e) {
    fail(e);
  }
}

// ───────────── projects ─────────────

export async function saveProject(id: string | null, input: { name: string; rootPath?: string | null; color?: string | null }) {
  try {
    const p = id ? await api.updateProject(id, input as ProjectPatch) : await api.createProject(input);
    await reload();
    return p;
  } catch (e) {
    fail(e);
    return null;
  }
}

/** Archive is the safe, reversible way to clear a project off the Galaxy. */
export async function archiveProject(id: string, archived: boolean) {
  try {
    const p = await api.archiveProject(id, archived);
    if (archived && getState().focus === id) setState({ focus: null, expanded: null });
    await reload();
    toast(
      archived
        ? { tone: "info", message: `Archived ${p.name}. Its sessions stay searchable.`, action: { label: "Undo", run: () => void archiveProject(id, false) } }
        : { tone: "success", message: `Restored ${p.name}` },
    );
  } catch (e) {
    fail(e);
  }
}

export async function deleteProject(id: string) {
  try {
    await api.deleteProject(id);
    focusProject(null);
    await reload();
    toast({ tone: "info", message: "Project removed. Its sessions moved to Unsorted." });
  } catch (e) {
    fail(e);
  }
}

// ───────────── scanning ─────────────

export async function scan(adapters?: string[]) {
  if (getState().scanning) return;
  setState({ scanning: true, overlay: { kind: "scan" }, scanReport: null });
  try {
    const report = await api.scan(adapters);
    setState({ scanReport: report });
    await reload();
  } catch (e) {
    fail(e);
    setState({ overlay: null });
  } finally {
    setState({ scanning: false });
  }
}

export async function loadIntegrations() {
  try {
    setState({ integrations: await api.integrationStatus() });
  } catch (e) {
    fail(e);
  }
}

let runtimeStarted = false;
let reloadTimer: number | undefined;

/**
 * Runtime updates are pushed: the backend monitor (src-tauri/src/runtime.rs) emits
 * `hub://runtime` whenever a state changes. Bursts are coalesced into one reload.
 */
export function startRuntimeUpdates() {
  if (runtimeStarted) return;
  runtimeStarted = true;
  const soon = () => {
    window.clearTimeout(reloadTimer);
    reloadTimer = window.setTimeout(() => void reload(), 150);
  };
  void listen("hub://runtime", soon).catch(() => {
    /* not running inside Tauri (e.g. tests) */
  });
  // Coming back to the window should never show stale state: run one pass right away.
  const now = async () => {
    try {
      if (await api.refreshRuntime()) soon();
    } catch {
      /* transient */
    }
  };
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void now();
  });
  window.addEventListener("focus", () => void now());
}
