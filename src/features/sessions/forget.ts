/**
 * Forgetting a session removes Hoku's record only; the provider's own copy is never touched.
 * Scans keep it forgotten until the provider shows activity after the forget (db::still_forgotten).
 * The one thing worth rescuing is the user's note, which can become the project's next step.
 */
import type { Project, Session } from "../../lib/types";

/** Mirrors db::NEXT_STEP_MAX. */
export const NEXT_STEP_MAX = 280;

export interface ForgetPlan {
  /** Found by a scan, so a scan can bring it back once it has new activity. */
  scanned: boolean;
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
    scanned: s.discovery === "scan",
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

/** What forgetting does, in one or two sentences. */
export function forgetMessage(plan: ForgetPlan, provider: string): string {
  const base = `Removes it from Hoku, with its note, links and activity. ${provider}’s copy isn’t touched.`;
  return plan.scanned ? `${base} Scans leave it out until it has new activity in ${provider}.` : base;
}
