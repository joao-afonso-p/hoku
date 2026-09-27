import { invoke } from "@tauri-apps/api/core";
import type {
  HubError,
  HubSnapshot,
  OpenResult,
  Outcome,
  OutcomeInput,
  ParsedReference,
  Project,
  ProjectSuggestion,
  Provider,
  ProviderAccount,
  ProviderGroup,
  Recap,
  RecapQuery,
  ScanReport,
  Session,
} from "./types";

/** Every backend error is a HubError; normalize anything else into one. */
export function toHubError(e: unknown): HubError {
  if (e && typeof e === "object" && "message" in e) return e as HubError;
  return { message: "Something went wrong.", detail: String(e) };
}

async function call<T>(cmd: string, args?: Record<string, unknown> | Uint8Array): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw toHubError(e);
  }
}

export interface SessionPatch {
  title?: string;
  notes?: string | null;
  projectId?: string | null;
  providerAccountId?: string | null;
  favorite?: boolean;
}

export interface ProjectPatch {
  name?: string;
  rootPath?: string | null;
  color?: string | null;
  icon?: string | null;
}

export const api = {
  snapshot: () => call<HubSnapshot>("get_snapshot"),

  createProject: (input: { name: string; rootPath?: string | null; color?: string | null }) =>
    call<Project>("create_project", { input }),
  updateProject: (id: string, patch: ProjectPatch) => call<Project>("update_project", { id, patch }),
  deleteProject: (id: string) => call<void>("delete_project", { id }),
  archiveProject: (id: string, archived: boolean) => call<Project>("archive_project", { id, archived }),
  projectSuggestions: () => call<ProjectSuggestion[]>("project_suggestions"),
  createProjectsFromSuggestions: (suggestions: { name: string; rootPath: string; color?: string | null }[]) =>
    call<number>("create_projects_from_suggestions", { suggestions }),

  parseReference: (provider: Provider, input: string) => call<ParsedReference>("parse_reference", { provider, input }),
  addManualSession: (input: {
    provider: Provider;
    reference: string;
    title: string;
    projectId?: string | null;
    providerAccountId?: string | null;
    workingDirectory?: string | null;
    notes?: string | null;
  }) => call<Session>("add_manual_session", { input }),
  updateSession: (id: string, patch: SessionPatch) => call<Session>("update_session", { id, patch }),
  deleteSession: (id: string) => call<void>("delete_session", { id }),
  setLink: (from: string, to: string, linked: boolean) => call<void>("set_link", { from, to, linked }),

  openSession: (id: string) => call<OpenResult>("open_session", { id }),
  copyText: (text: string) => call<void>("copy_text", { text }),
  spacesSwitchEnabled: () => call<boolean>("spaces_switch_enabled"),
  openSpacesSettings: () => call<void>("open_spaces_settings"),
  revealPath: (path: string) => call<void>("reveal_path", { path }),
  openProviderApp: (app: "claude" | "codex") => call<void>("open_provider_app", { app }),

  recap: (query: RecapQuery) => call<Recap>("get_recap", { query }),
  createOutcome: (input: OutcomeInput) => call<Outcome>("create_outcome", { input }),
  updateOutcome: (id: string, input: OutcomeInput) => call<Outcome>("update_outcome", { id, input }),
  deleteOutcome: (id: string) => call<void>("delete_outcome", { id }),
  /** The PNG travels as the raw request body. Returns the saved file's path. */
  saveRecapImage: (png: Uint8Array) => call<string>("save_recap_image", png),
  copyRecapImage: (png: Uint8Array) => call<void>("copy_recap_image", png),

  scan: (adapters?: string[]) => call<ScanReport>("scan_sessions", { adapters: adapters ?? null }),
  refreshRuntime: () => call<boolean>("refresh_runtime"),
  integrationStatus: () => call<ProviderGroup[]>("integration_status"),

  createAccount: (provider: "claude" | "codex", label: string) =>
    call<ProviderAccount>("create_account", { provider, label }),
  renameAccount: (id: string, label: string) => call<void>("rename_account", { id, label }),
  setSetting: (key: string, value: unknown) => call<void>("set_setting", { key, value }),
  loadDemo: () => call<void>("load_demo"),
  clearDemo: () => call<void>("clear_demo"),
  databasePath: () => call<string>("database_path"),
};
