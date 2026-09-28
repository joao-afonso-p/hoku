// Mirrors src-tauri/src/models.rs (serde camelCase).

export type Provider = "claude-code" | "claude" | "codex";

/** Normalized runtime state. See docs/runtime-state.md. */
export type RuntimeState = "working" | "needs_input" | "ready" | "idle" | "offline" | "error" | "unknown";
export type Confidence = "high" | "medium" | "low";

export interface RuntimeStatus {
  state: RuntimeState;
  confidence: Confidence;
  /** "Waiting for permission", "Running Bash", "Finished its turn". */
  reason?: string | null;
  /** Specifics: the tool, the question asked, an error message. */
  detail?: string | null;
  /** Signal it came from: "claude-code-registry", "codex-rollout", … */
  source?: string | null;
  /** A human has to act. Always true for needs_input; true for errors like auth failures. */
  actionRequired: boolean;
  /** When the current state began. */
  since?: string | null;
  lastObservedAt?: string | null;
}

export type ActivityEventType =
  | "started_working"
  | "needs_input"
  | "became_ready"
  | "became_idle"
  | "went_offline"
  | "error"
  | "resumed"
  | "opened"
  | "created"
  | "status_changed";

export interface ActivityEvent {
  id: string;
  sessionId: string;
  type: ActivityEventType;
  provider: Provider;
  timestamp: string;
  title?: string | null;
  fromState?: RuntimeState | null;
  toState?: RuntimeState | null;
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
}

export type SupportLevel = "full" | "partial" | "none";

export interface RuntimeCapabilities {
  liveStatus: "full" | "partial" | "limited" | "none";
  working: SupportLevel;
  needsInput: SupportLevel;
  ready: SupportLevel;
  error: SupportLevel;
  detail: string;
}

export interface Project {
  id: string;
  name: string;
  rootPath?: string | null;
  icon?: string | null;
  color?: string | null;
  /** Stable galaxy slot, assigned once. */
  slot: number;
  isDemo: boolean;
  /** Archived: off the Galaxy, still searchable, restorable in place. */
  archivedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderAccount {
  id: string;
  provider: "claude" | "codex";
  label: string;
  authMode: "external-app" | "oauth" | "api-key" | "local-session";
  status: "connected" | "disconnected" | "partial";
  metadata?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface Session {
  id: string;
  provider: Provider;
  providerAccountId?: string | null;
  externalId?: string | null;
  title: string;
  projectId?: string | null;
  workingDirectory?: string | null;
  repository?: string | null;
  branch?: string | null;
  source?: string | null;
  sourceUrl?: string | null;
  deepLink?: string | null;
  lastActivityAt?: string | null;
  lastOpenedAt?: string | null;
  runtime: RuntimeStatus;
  favorite: boolean;
  notes?: string | null;
  metadata?: Record<string, unknown> | null;
  discovery: "manual" | "scan";
  projectLocked: boolean;
  titleLocked: boolean;
  sourceMissing: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SessionLink {
  fromId: string;
  toId: string;
  kind: string;
  createdAt: string;
}

export interface ScanRun {
  adapter: string;
  finishedAt: string;
  found: number;
  new: number;
  updated: number;
  status: string;
}

export interface HubSnapshot {
  projects: Project[];
  sessions: Session[];
  accounts: ProviderAccount[];
  links: SessionLink[];
  lastScans: ScanRun[];
  settings: Record<string, unknown>;
  /** Semantic runtime events from the last 30 days, newest first. */
  activity: ActivityEvent[];
}

export interface ProviderScanResult {
  adapter: string;
  provider: Provider;
  label: string;
  status: "ok" | "unavailable" | "manual-only" | "error";
  found: number;
  new: number;
  updated: number;
  message?: string | null;
  detail?: string | null;
}

export interface ProjectSuggestion {
  name: string;
  rootPath: string;
  color?: string | null;
  sessionCount: number;
  source: string;
}

export interface ScanReport {
  startedAt: string;
  finishedAt: string;
  results: ProviderScanResult[];
  suggestions: ProjectSuggestion[];
}

export interface OpenResult {
  method: "deep-link" | "attach" | "resume" | "focus" | "fallback";
  message: string;
  /** "spaces-setting": the terminal is on another desktop and macOS won't switch there. */
  hint?: string | null;
}

export interface ParsedReference {
  externalId: string;
  deepLink?: string | null;
  sourceUrl?: string | null;
  kind: string;
  summary: string;
}

/** What macOS allows Hoku to show (src-tauri/src/attention.rs). */
export interface NotificationStatus {
  /** "unavailable": this build can't post notifications (an unbundled dev binary). */
  permission: "authorized" | "provisional" | "denied" | "not-determined" | "unavailable";
  /** Alerts (banners) are on for Hoku in System Settings. */
  alerts: boolean;
  /** "Badge application icon" is on for Hoku in System Settings. */
  badges: boolean;
}

/** A clicked Needs You banner. `sessionId: null` leads to the Needs You inbox. */
export interface NotificationTarget {
  sessionId: string | null;
}

export interface HubError {
  message: string;
  detail?: string | null;
}

export interface IntegrationComponent {
  id: string;
  name: string;
  kind: "app" | "cli";
  installed: boolean;
  running: boolean;
  version?: string | null;
  path?: string | null;
  /** A copy shipped inside the desktop app, when the CLI isn't on PATH. */
  bundledPath?: string | null;
}

export interface IntegrationAccount {
  status: "connected" | "disconnected" | "unknown";
  label: string;
  detail?: string | null;
  managedBy: string;
  hint?: string | null;
}

export interface IntegrationCapability {
  adapter: string;
  label: string;
  discovery: "indexed-read-only" | "manual-only" | "unavailable";
  open: "direct" | "fallback" | "unavailable";
  detail: string;
  runtime: RuntimeCapabilities;
}

export interface ProviderGroup {
  id: "claude" | "codex";
  name: string;
  account: IntegrationAccount;
  components: IntegrationComponent[];
  capabilities: IntegrationCapability[];
}
