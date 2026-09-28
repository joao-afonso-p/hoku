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
  /** Project Resume: what this project is, in the user's words (or an accepted AI draft). */
  description?: string | null;
  /** Project Resume: where to pick up next. */
  nextStep?: string | null;
  resumeUpdatedAt?: string | null;
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
  /** In the user's Follow up queue. User-owned; scans and the runtime monitor never touch it. */
  followUp?: FollowUp | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The user's own intention to come back to a session ("Review later"). Not a runtime state:
 * Needs You is a provider blocking on a human; Follow up is the human's reminder.
 */
export interface FollowUp {
  /** When it was put in the queue. */
  addedAt: string;
  /** Remind at / snoozed until. null = no date. */
  dueAt?: string | null;
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

// ───── Recaps (src-tauri/src/recap.rs) ─────

export interface RecapQuery {
  since: string;
  until: string;
  utcOffsetMinutes: number;
  /** Project ids or "unsorted". Empty = every project. */
  projects: string[];
}

export interface RecapDay {
  /** Local calendar day, YYYY-MM-DD. */
  date: string;
  /** Distinct sessions active that day. */
  sessions: number;
  /** Hoku recorded a runtime transition that day (any project). */
  observed: boolean;
}

export interface RecapTotals {
  projects: number;
  sessions: number;
  activeDays: number;
  observedSessions: number;
  workStarts: number;
  /** Turns that finished and handed back. Never "tasks completed". */
  readyTransitions: number;
  inputRequests: number;
}

export interface RecapProvider {
  provider: Provider;
  sessions: number;
}

export interface RecapProject {
  /** Project id or "unsorted". */
  key: string;
  name: string;
  color?: string | null;
  isDemo: boolean;
  archived: boolean;
  sessions: number;
  activeDays: number;
  readyTransitions: number;
  pullRequests: number;
  providers: RecapProvider[];
  lastActivityAt?: string | null;
}

export interface RecapPullRequest {
  sessionId: string;
  projectKey: string;
  url: string;
  repo?: string | null;
  number?: number | null;
  lastActivityAt?: string | null;
}

export interface RecapCoverage {
  retentionDays: number;
  historySince?: string | null;
  historyCoversRange: boolean;
  observedDays: number;
  rangeDays: number;
}

/** A milestone the user wrote. Hoku never creates these. */
export interface Outcome {
  id: string;
  projectId?: string | null;
  text: string;
  /** Local calendar day, YYYY-MM-DD. */
  occurredOn: string;
  createdAt: string;
  updatedAt: string;
}

export interface OutcomeInput {
  projectId?: string | null;
  text: string;
  occurredOn: string;
}

export interface Recap {
  since: string;
  until: string;
  days: RecapDay[];
  totals: RecapTotals;
  providers: RecapProvider[];
  projects: RecapProject[];
  pullRequests: RecapPullRequest[];
  outcomes: Outcome[];
  coverage: RecapCoverage;
}

/** The optional AI draft provider (src-tauri/src/resume.rs). */
export interface DraftProviderStatus {
  provider: "claude-code";
  /** The user turned drafts on in Settings. Off by default. */
  enabled: boolean;
  installed: boolean;
  version?: string | null;
  /** null when the CLI's status couldn't be read. */
  signedIn?: boolean | null;
  /** The CLI supports every flag Hoku needs for a tool-less, session-less run. */
  supported: boolean;
  missingFlags: string[];
}

/** Exactly what Generate would send, for the user to inspect first. */
export interface PreparedDraft {
  token: string;
  systemPrompt: string;
  prompt: string;
  sessionCount: number;
  eventCount: number;
  noteCount: number;
  hasDescription: boolean;
  hasNextStep: boolean;
}

/** An unsaved, editable draft. */
export interface ResumeDraft {
  description?: string | null;
  nextStep?: string | null;
}
