import { openOverlay, showGalaxy, showRecaps, showSessions, toggleList } from "../app/actions";
import { useHub, type ListMode } from "../app/store";
import { needsYou, ATTENTION } from "../features/runtime/status";
import { IconActivity, IconGalaxy, IconInbox, IconList, IconOrbit, IconProjects, IconRecap, IconSettings, IconStar } from "./Icons";

function RailButton({ label, active, onClick, children, count }: { label: string; active?: boolean; onClick: () => void; children: React.ReactNode; count?: number }) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={count ? `${label}, ${count}` : label}
      className={`group relative flex h-9 w-9 items-center justify-center rounded-[9px] transition-colors ${
        active ? "bg-white/[0.07] text-ink" : "text-ink-3 hover:bg-white/[0.04] hover:text-ink-2"
      }`}
    >
      {children}
      {!!count && (
        <span
          className="absolute top-[3px] right-[2px] flex h-[14px] min-w-[14px] items-center justify-center rounded-full px-[3px] text-[9.5px] leading-none font-semibold text-[#1a150c] tabular-nums"
          style={{ background: ATTENTION, boxShadow: `0 0 0 2px var(--color-ground), 0 0 8px ${ATTENTION}55` }}
        >
          {count > 99 ? "99+" : count}
        </span>
      )}
      <span className="pointer-events-none absolute left-11 z-50 rounded-md border border-line bg-raised px-2 py-1 text-[11.5px] whitespace-nowrap text-ink-2 opacity-0 transition-opacity group-hover:opacity-100 group-hover:delay-300">
        {label}
        {!!count && <span style={{ color: ATTENTION }}> · {count}</span>}
      </span>
    </button>
  );
}

/**
 * Destinations, not states. Needs You is here because it means "a human must act";
 * Working, Ready, Idle and Offline are filters, never places.
 */
export function Rail() {
  const list = useHub((s) => s.list);
  const view = useHub((s) => s.view);
  const focus = useHub((s) => s.focus);
  const overlay = useHub((s) => s.overlay);
  const needsCount = useHub((s) => s.data.sessions.filter(needsYou).length);
  const onGalaxy = view === "galaxy";
  const listBtn = (mode: ListMode) => ({ active: onGalaxy && list === mode, onClick: () => toggleList(mode) });

  return (
    <nav className="relative z-30 flex w-[56px] shrink-0 flex-col items-center gap-1 border-r border-line bg-ground/80 pt-[46px] pb-3">
      <div data-tauri-drag-region className="absolute inset-x-0 top-0 h-[40px]" />
      <RailButton label="Galaxy" active={onGalaxy && !focus && !list} onClick={showGalaxy}>
        <IconGalaxy />
      </RailButton>
      <RailButton label="Needs You" {...listBtn("needs")} count={needsCount}>
        <IconInbox />
      </RailButton>
      <RailButton label="Activity" {...listBtn("activity")}>
        <IconActivity />
      </RailButton>
      <RailButton label="Favorites" {...listBtn("favorites")}>
        <IconStar />
      </RailButton>
      <RailButton label="Projects" {...listBtn("projects")}>
        <IconProjects />
      </RailButton>
      <RailButton label="Sessions" active={view === "sessions"} onClick={showSessions}>
        <IconList />
      </RailButton>
      <RailButton label="Recaps" active={view === "recaps"} onClick={showRecaps}>
        <IconRecap />
      </RailButton>
      <div className="flex-1" />
      <div className="mb-1 h-px w-6 bg-line" />
      <RailButton label="Integrations" active={overlay?.kind === "integrations"} onClick={() => openOverlay({ kind: "integrations" })}>
        <IconOrbit />
      </RailButton>
      <RailButton label="Settings" active={overlay?.kind === "settings"} onClick={() => openOverlay({ kind: "settings" })}>
        <IconSettings />
      </RailButton>
    </nav>
  );
}
