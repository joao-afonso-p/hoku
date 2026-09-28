/**
 * Forgetting a session removes Hoku's record only; the provider's own copy is never touched.
 * The one thing worth rescuing is the user's note, which can become the project's next step.
 */
import type { Project, Session } from "../../lib/types";

/** Mirrors db::NEXT_STEP_MAX. */
export const NEXT_STEP_MAX = 280;

export interface ForgetPlan {
  /** A scan adds it back while the provider still has it. */
  mayReturn: boolean;
  /** The note can be kept as the project's next step. */
  canKeep: boolean;
  /** The trimmed note. */
  note: string;
  /** The next step keeping the note would replace. */
  replaces: string | null;
  /** Keep the note unless that would overwrite a next step the user already wrote. */
  keepByDefault: boolean;
}

/** `note` is the text in the inspector, which may not have saved yet. */
export function forgetPlan(s: Session, project: Project | undefined, note = s.notes ?? ""): ForgetPlan {
  const trimmed = note.trim();
  const replaces = project?.nextStep?.trim() || null;
  const canKeep = !!project && project.id === s.projectId && !project.isDemo && s.source !== "demo" && trimmed !== "";
  return {
    mayReturn: s.discovery === "scan" && !s.sourceMissing,
    canKeep,
    note: trimmed,
    replaces,
    keepByDefault: canKeep && !replaces,
  };
}

/** Characters as the backend counts them (Unicode scalars, after trimming). */
export function nextStepLength(text: string): number {
  return [...text.trim()].length;
}
