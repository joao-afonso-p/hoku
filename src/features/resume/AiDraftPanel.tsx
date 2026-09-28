import { useEffect, useState } from "react";
import { saveProjectResume } from "../../app/actions";
import { api, toHubError } from "../../lib/api";
import type { HubError, PreparedDraft, Project } from "../../lib/types";
import { StatusDot } from "../runtime/StatusMark";
import { HOW_IT_RUNS, NEVER_SENT } from "./privacy";

type Phase =
  | { k: "loading" }
  | { k: "review"; prepared: PreparedDraft }
  | { k: "generating"; prepared: PreparedDraft }
  | { k: "draft"; description: string; nextStep: string }
  | { k: "error"; error: HubError; prepared: PreparedDraft | null };

const DESCRIPTION_MAX = 600;
const NEXT_STEP_MAX = 280;

/**
 * The explicit AI draft flow: inspect exactly what will be sent → Generate → edit → Use draft.
 * Nothing is sent before Generate, and nothing is saved before Use draft.
 */
export function AiDraftPanel({ project, onClose }: { project: Project; onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>({ k: "loading" });

  const prepare = () => {
    setPhase({ k: "loading" });
    api
      .prepareResumeDraft(project.id)
      .then((prepared) => setPhase({ k: "review", prepared }))
      .catch((e) => setPhase({ k: "error", error: toHubError(e), prepared: null }));
  };
  useEffect(prepare, [project.id]);

  const generate = async (prepared: PreparedDraft) => {
    setPhase({ k: "generating", prepared });
    try {
      const d = await api.generateResumeDraft(prepared.token);
      setPhase({ k: "draft", description: d.description ?? "", nextStep: d.nextStep ?? "" });
    } catch (e) {
      setPhase({ k: "error", error: toHubError(e), prepared });
    }
  };

  const accept = async (description: string, nextStep: string) => {
    const patch: { description?: string; nextStep?: string } = {};
    if (description.trim()) patch.description = description;
    if (nextStep.trim()) patch.nextStep = nextStep;
    if (!patch.description && !patch.nextStep) return onClose();
    if (await saveProjectResume(project.id, patch, "Draft saved to Resume")) onClose();
  };

  return (
    <div className="mt-2 rounded-[10px] border border-line-strong bg-white/[0.025] p-3 text-[12px]" role="region" aria-label="AI draft">
      <div className="mb-2">
        <div className="eyebrow text-ink-2">Draft with Claude</div>
        <div className="mt-0.5 text-[11px] text-ink-4">Optional · nothing is sent until you generate, nothing is saved until you accept</div>
      </div>

      {phase.k === "loading" && <div className="text-ink-3">Preparing the preview…</div>}

      {phase.k === "review" && (
        <>
          <p className="leading-relaxed text-ink-2">Generate sends this to Claude through your Claude Code CLI:</p>
          <ul className="mt-1.5 list-disc space-y-0.5 pl-4 leading-relaxed text-ink-3">
            <li>
              The project name{phase.prepared.hasDescription || phase.prepared.hasNextStep ? ", your current description and next step" : ""}
            </li>
            <li>
              {phase.prepared.sessionCount} {phase.prepared.sessionCount === 1 ? "session" : "sessions"}: titles, states, branch names, PR numbers
            </li>
            {phase.prepared.noteCount > 0 && (
              <li>
                Your notes on {phase.prepared.noteCount} {phase.prepared.noteCount === 1 ? "session" : "sessions"}
              </li>
            )}
            <li>
              {phase.prepared.eventCount} recent activity {phase.prepared.eventCount === 1 ? "event" : "events"}
            </li>
          </ul>
          <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-4">{NEVER_SENT}</p>
          <details className="mt-2">
            <summary className="cursor-pointer text-[11.5px] text-ink-3 hover:text-ink-2">
              Show the exact text ({(phase.prepared.systemPrompt.length + phase.prepared.prompt.length).toLocaleString()} characters)
            </summary>
            <div className="mt-1.5 max-h-[220px] overflow-y-auto rounded-[7px] border border-line bg-black/25 p-2 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap text-ink-3 select-text">
              <div className="text-ink-4">— Instructions —</div>
              {phase.prepared.systemPrompt}
              <div className="mt-2 text-ink-4">— Project data —</div>
              {phase.prepared.prompt}
            </div>
          </details>
          <p className="mt-2 text-[11px] leading-relaxed text-ink-4">{HOW_IT_RUNS}</p>
          <div className="mt-2.5 flex justify-end gap-1.5">
            <button className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={() => void generate(phase.prepared)}>
              Generate draft
            </button>
          </div>
        </>
      )}

      {phase.k === "generating" && (
        <div className="flex items-center gap-2 text-ink-2" role="status">
          <StatusDot status="working" size={7} /> Waiting for Claude Code… this usually takes a few seconds, and stops after two minutes.
        </div>
      )}

      {phase.k === "draft" && (
        <DraftEditor
          initialDescription={phase.description}
          initialNextStep={phase.nextStep}
          hasExisting={!!project.description || !!project.nextStep}
          onDiscard={onClose}
          onAccept={(d, n) => void accept(d, n)}
        />
      )}

      {phase.k === "error" && (
        <>
          <div className="text-danger">{phase.error.message}</div>
          {phase.error.detail && <div className="mt-1 font-mono text-[10.5px] break-words text-ink-4 select-text">{phase.error.detail}</div>}
          <div className="mt-2.5 flex justify-end gap-1.5">
            <button className="btn btn-ghost" onClick={onClose}>
              Close
            </button>
            <button className="btn" onClick={prepare}>
              Review again
            </button>
            {phase.prepared && (
              <button className="btn btn-primary" onClick={() => void generate(phase.prepared!)}>
                Retry
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function DraftEditor({
  initialDescription,
  initialNextStep,
  hasExisting,
  onDiscard,
  onAccept,
}: {
  initialDescription: string;
  initialNextStep: string;
  hasExisting: boolean;
  onDiscard: () => void;
  onAccept: (description: string, nextStep: string) => void;
}) {
  const [description, setDescription] = useState(initialDescription);
  const [nextStep, setNextStep] = useState(initialNextStep);
  const tooLong = description.length > DESCRIPTION_MAX || nextStep.length > NEXT_STEP_MAX;
  return (
    <>
      <p className="mb-2 text-[11.5px] leading-relaxed text-ink-3">
        A draft from Claude, based only on titles, states, notes and events. Check and edit it before using it.
      </p>
      <label className="block">
        <span className="mb-1 flex justify-between text-[11px] text-ink-3">
          Description <span className="tabular-nums text-ink-4">{description.length}/{DESCRIPTION_MAX}</span>
        </span>
        <textarea autoFocus className="field min-h-[72px] resize-y text-[12.5px] leading-relaxed" value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label className="mt-2 block">
        <span className="mb-1 flex justify-between text-[11px] text-ink-3">
          Next step <span className="tabular-nums text-ink-4">{nextStep.length}/{NEXT_STEP_MAX}</span>
        </span>
        <textarea className="field min-h-[48px] resize-y text-[12.5px] leading-relaxed" value={nextStep} onChange={(e) => setNextStep(e.target.value)} />
      </label>
      <p className="mt-1.5 text-[11px] text-ink-4">
        {hasExisting ? "Use draft replaces the current text. A field you leave empty stays as it is." : "A field you leave empty isn't saved."}
      </p>
      <div className="mt-2.5 flex justify-end gap-1.5">
        <button className="btn btn-ghost" onClick={onDiscard}>
          Discard
        </button>
        <button className="btn btn-primary" disabled={tooLong} onClick={() => onAccept(description, nextStep)}>
          Use draft
        </button>
      </div>
    </>
  );
}
