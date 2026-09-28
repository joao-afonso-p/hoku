/**
 * Needs You outside the window: the preferences, and where a clicked banner leads. The backend
 * decides when to alert (src-tauri/src/attention.rs); the keys and defaults here mirror it.
 */
import type { NotificationTarget, Session } from "../../lib/types";

export const NOTIFY_KEYS = {
  banners: "notifications.needsYou",
  badge: "notifications.dockBadge",
  bounce: "notifications.dockBounce",
} as const;

export interface NotificationPrefs {
  /** A banner when a session starts needing you. Off until turned on (macOS asks then). */
  banners: boolean;
  /** The Needs You count on the Dock icon. */
  badge: boolean;
  /** One Dock bounce when a session starts needing you. */
  bounce: boolean;
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = { banners: false, badge: true, bounce: false };

export function notificationPrefs(settings: Record<string, unknown>): NotificationPrefs {
  const flag = (k: keyof NotificationPrefs) => {
    const v = settings[NOTIFY_KEYS[k]];
    return typeof v === "boolean" ? v : DEFAULT_NOTIFICATION_PREFS[k];
  };
  return { banners: flag("banners"), badge: flag("badge"), bounce: flag("bounce") };
}

export type NotificationDestination = { kind: "session"; session: Session } | { kind: "inbox"; missing: boolean };

/** The exact session if it still exists, otherwise the Needs You inbox. */
export function notificationDestination(target: NotificationTarget, sessions: Session[]): NotificationDestination {
  if (!target.sessionId) return { kind: "inbox", missing: false };
  const session = sessions.find((s) => s.id === target.sessionId);
  return session ? { kind: "session", session } : { kind: "inbox", missing: true };
}
