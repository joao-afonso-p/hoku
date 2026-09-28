import { useEffect, useMemo } from "react";
import { Rail } from "../components/Rail";
import { Toasts } from "../components/Toasts";
import { TopBar } from "../components/TopBar";
import { drawerWidth, ListDrawer, listHighlight } from "../features/activity/ListDrawer";
import { CommandPalette } from "../features/command-palette/CommandPalette";
import { Constellation } from "../features/constellation/Constellation";
import { IntegrationCenter } from "../features/integrations/IntegrationCenter";
import { EmptyState } from "../features/onboarding/EmptyState";
import { ProjectSheet } from "../features/projects/ProjectSheet";
import { RecapsView } from "../features/recaps/RecapsView";
import { ScanSheet } from "../features/scan/ScanSheet";
import { GalaxyControls } from "../features/galaxy/GalaxyControls";
import { ambienceFromSettings } from "../features/constellation/Starfield";
import { statusKey } from "../features/runtime/status";
import { AddSessionSheet } from "../features/sessions/AddSessionSheet";
import { SessionsView } from "../features/sessions/SessionsView";
import { INSPECTOR_WIDTH, Inspector } from "../features/sessions/Inspector";
import { SettingsSheet } from "../features/settings/SettingsSheet";
import { ResumeDrawer } from "../features/resume/ResumeDrawer";
import { SpacesHelpSheet } from "../features/sessions/SpacesHelpSheet";
import { ageMs } from "../lib/time";
import { isSessionVisible, visibilityFromSettings } from "../features/galaxy/visibility";
import { setVisibility, showGalaxy, closeOverlay, copy, escape, focusProject, openOverlay, openSession, patchSession, reload, scan, select, startRuntimeUpdates, toast, toggleResume } from "./actions";
import { UNSORTED, useSession, useSystems, useVisibility } from "./model";
import { getState, useHub } from "./store";

export function App() {
  const loaded = useHub((s) => s.loaded);
  const loadError = useHub((s) => s.loadError);
  const focus = useHub((s) => s.focus);
  const selectedId = useHub((s) => s.selectedId);
  const overlay = useHub((s) => s.overlay);
  const list = useHub((s) => s.list);
  const view = useHub((s) => s.view);
  const statusFilter = useHub((s) => s.statusFilter);
  const activity = useHub((s) => s.data.activity);
  const activityRange = useHub((s) => s.activityRange);
  const activityProvider = useHub((s) => s.activityProvider);
  const links = useHub((s) => s.data.links);
  const ambience = useHub((s) => ambienceFromSettings(s.data.settings));
  const sessions = useHub((s) => s.data.sessions);
  const projectsCount = useHub((s) => s.data.projects.length);
  const systems = useSystems();
  const visibility = useVisibility();
  const selected = useSession(selectedId);
  const resumeProject = useHub((s) => (s.list === "resume" && s.focus ? (s.data.projects.find((p) => p.id === s.focus && !p.archivedAt) ?? null) : null));

  useEffect(() => {
    void reload();
    startRuntimeUpdates();
  }, []);

  useGlobalKeys(systems.map((s) => s.key));

  // What the canvas emphasises: the open drawer's sessions, narrowed by the status filter.
  const highlight = useMemo(() => {
    const fromList = list ? listHighlight(list, sessions, activity, activityRange, activityProvider) : null;
    if (statusFilter.length === 0) return fromList;
    const out = new Set<string>();
    for (const s of sessions) if (statusFilter.includes(statusKey(s)) && (!fromList || fromList.has(s.id))) out.add(s.id);
    return out;
  }, [list, sessions, activity, activityRange, activityProvider, statusFilter]);

  const empty = loaded && sessions.length === 0 && projectsCount === 0;
  const drawerInset = list && (list !== "resume" || resumeProject) ? drawerWidth(list) + 12 : 0;

  return (
    <div className="flex h-full">
      <Rail />
      <main className="relative flex-1 overflow-hidden">
        {loaded && !empty && (
          <Constellation
            systems={systems}
            focus={focus}
            selectedId={selectedId}
            highlight={highlight}
            links={links}
            insetLeft={drawerInset}
            filtering={statusFilter.length > 0}
            insetRight={selected ? INSPECTOR_WIDTH + 12 : 0}
            insetTop={view === "galaxy" ? 80 : 44}
            mode={visibility.mode}
            recentWindowDays={visibility.recentWindowDays}
            ambience={ambience}
            onSelect={select}
            onFocus={focusProject}
            onOpen={(s) => void openSession(s)}
            onReassign={(id, key) => {
              const name = systems.find((s) => s.key === key)?.name ?? "project";
              void patchSession(id, { projectId: key === UNSORTED ? null : key }, true).then(() => toast({ tone: "success", message: `Moved to ${name}` }));
            }}
          />
        )}
        {empty && <EmptyState />}
        {loadError && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="max-w-md text-center text-[13px] text-ink-2">
              {loadError.message}
              {loadError.detail && <div className="mt-2 font-mono text-[11px] text-ink-4">{loadError.detail}</div>}
            </div>
          </div>
        )}

        {loaded && !empty && view === "galaxy" && <GalaxyControls systems={systems} left={drawerInset} mode={visibility.mode} windowDays={visibility.recentWindowDays} />}
        {view === "sessions" && <SessionsView insetRight={selected ? INSPECTOR_WIDTH + 12 : 0} />}
        {view === "recaps" && <RecapsView />}
        <TopBar systems={systems} />
        {list && list !== "resume" && <ListDrawer mode={list} systems={systems} />}
        {resumeProject && <ResumeDrawer project={resumeProject} />}
        {selected && view !== "recaps" && <Inspector key={selected.id} session={selected} />}

        {overlay?.kind === "palette" && <CommandPalette />}
        {overlay?.kind === "add-session" && <AddSessionSheet projectId={overlay.projectId} />}
        {overlay?.kind === "project" && <ProjectSheet projectId={overlay.projectId} />}
        {overlay?.kind === "integrations" && <IntegrationCenter />}
        {overlay?.kind === "settings" && <SettingsSheet />}
        {overlay?.kind === "scan" && <ScanSheet />}
        {overlay?.kind === "spaces-help" && <SpacesHelpSheet app={overlay.app} />}
        <Toasts />
      </main>
    </div>
  );
}

function isTyping(e: KeyboardEvent) {
  const el = e.target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

function useGlobalKeys(systemKeys: string[]) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = getState();
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (s.overlay?.kind === "palette") closeOverlay();
        else openOverlay({ kind: "palette" });
        return;
      }
      if (isTyping(e) || (s.overlay && s.overlay.kind !== "scan")) {
        if (e.key === "Escape" && !isTyping(e)) escape();
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === "a") {
        e.preventDefault();
        void setVisibility({ mode: visibilityFromSettings(s.data.settings).mode === "all" ? "current" : "all" });
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void scan();
      } else if (mod && e.key.toLowerCase() === "n") {
        e.preventDefault();
        openOverlay({ kind: "add-session", projectId: s.focus });
      } else if (mod && e.key === "0") {
        e.preventDefault();
        showGalaxy();
      } else if (mod && /^[1-9]$/.test(e.key)) {
        e.preventDefault();
        const projects = systemKeys.filter((k) => k !== UNSORTED);
        const key = projects[Number(e.key) - 1];
        if (key) focusProject(key);
      } else if (!mod && !e.altKey && e.key.toLowerCase() === "r" && s.focus && s.focus !== UNSORTED && s.view === "galaxy") {
        e.preventDefault();
        toggleResume(s.focus);
      } else if (e.key === "Escape") {
        escape();
      } else if (s.view === "recaps" && (e.key === "Enter" || e.key === "Tab")) {
        // Recaps is a form: Tab and Enter move through and press its controls.
      } else if (e.key === "Enter" && s.selectedId) {
        const session = s.data.sessions.find((x) => x.id === s.selectedId);
        if (session) void openSession(session);
      } else if (e.key === "Tab" && s.focus) {
        e.preventDefault();
        cycle(e.shiftKey ? -1 : 1);
      } else if (mod && e.key.toLowerCase() === "c" && s.selectedId && !window.getSelection()?.toString()) {
        const session = s.data.sessions.find((x) => x.id === s.selectedId);
        if (session?.externalId) {
          e.preventDefault();
          void copy(session.externalId, "ID");
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [systemKeys]);
}

/** Tab through the focused project's sessions, most recent first. */
function cycle(dir: 1 | -1) {
  const s = getState();
  const v = visibilityFromSettings(s.data.settings);
  const all = s.expanded === s.focus;
  const members = s.data.sessions
    .filter((x) => (s.focus === UNSORTED ? !x.projectId : x.projectId === s.focus))
    .filter((x) => all || isSessionVisible(x, v))
    .sort((a, b) => ageMs(a.lastActivityAt) - ageMs(b.lastActivityAt));
  if (members.length === 0) return;
  const i = members.findIndex((x) => x.id === s.selectedId);
  const next = i < 0 ? (dir === 1 ? 0 : members.length - 1) : (i + dir + members.length) % members.length;
  select(members[next].id);
}
