import { useState } from "react";
import { archiveProject, closeOverlay, deleteProject, focusProject, saveProject, toast } from "../../app/actions";
import { useHub } from "../../app/store";
import { Field, Sheet } from "../../components/Sheet";

/** Muted accents that sit comfortably on graphite. */
export const PROJECT_COLORS = ["#f1ead8", "#e2b27c", "#dc9a7f", "#d994b8", "#b39ae0", "#9fb4ea", "#7fbfb4", "#8fbf8a", "#d6c27a"];

export function ProjectSheet({ projectId }: { projectId?: string | null }) {
  const existing = useHub((s) => s.data.projects.find((p) => p.id === projectId) ?? null);
  const sessionCount = useHub((s) => s.data.sessions.filter((x) => x.projectId === projectId).length);
  const [name, setName] = useState(existing?.name ?? "");
  const [root, setRoot] = useState(existing?.rootPath ?? "");
  const [color, setColor] = useState<string | null>(existing?.color ?? null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const submit = async () => {
    const p = await saveProject(existing?.id ?? null, { name, rootPath: root.trim() || null, color });
    if (!p) return;
    closeOverlay();
    if (!existing) {
      focusProject(p.id);
      toast({ tone: "success", message: `Created ${p.name}` });
    }
  };

  return (
    <Sheet
      title={existing ? (existing.archivedAt ? "Archived project" : "Edit project") : "New project"}
      subtitle={
        existing
          ? existing.archivedAt
            ? "Off the Galaxy. Its sessions are still in Sessions and ⌘K, and new ones in its folder still join it."
            : undefined
          : "A project is a star system. Sessions whose folder is inside its root join it automatically."
      }
      width={440}
      footer={
        <>
          {existing && (
            <div className="mr-auto flex items-center gap-1">
              {/* Archive is the safe default; delete is secondary and says what happens. */}
              <button
                className="btn"
                onClick={() => void archiveProject(existing.id, !existing.archivedAt).then(closeOverlay)}
                title={existing.archivedAt ? "Put it back on the Galaxy, where it was" : "Hide it from the Galaxy. Sessions, root and position are kept"}
              >
                {existing.archivedAt ? "Restore" : "Archive"}
              </button>
              {confirmDelete ? (
                <button className="btn btn-ghost text-danger" onClick={() => void deleteProject(existing.id).then(closeOverlay)}>
                  Delete · {sessionCount} {sessionCount === 1 ? "session moves" : "sessions move"} to Unsorted
                </button>
              ) : (
                <button className="btn btn-ghost text-[12px] text-ink-4 hover:text-danger" onClick={() => setConfirmDelete(true)}>
                  Delete…
                </button>
              )}
            </div>
          )}
          <button className="btn btn-ghost" onClick={closeOverlay}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!name.trim()} onClick={() => void submit()}>
            {existing ? "Save" : "Create project"}
          </button>
        </>
      }
    >
      <form
        className="space-y-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) void submit();
        }}
      >
        <Field label="Name">
          <input autoFocus className="field" placeholder="Atlas" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Root folder" hint="optional · used for auto-association">
          <input className="field font-mono text-[12px]" placeholder="~/Projects/atlas" value={root} onChange={(e) => setRoot(e.target.value)} spellCheck={false} />
        </Field>
        <Field label="Accent">
          <div className="flex items-center gap-2">
            {PROJECT_COLORS.map((c) => (
              <button
                type="button"
                key={c}
                onClick={() => setColor(c === PROJECT_COLORS[0] ? null : c)}
                className="flex h-6 w-6 items-center justify-center rounded-full"
                style={{ boxShadow: (color ?? PROJECT_COLORS[0]) === c ? `0 0 0 1px ${c}` : undefined }}
                aria-label={`Accent ${c}`}
              >
                <span className="h-3 w-3 rounded-full" style={{ background: c, opacity: 0.9 }} />
              </button>
            ))}
          </div>
        </Field>
        <button type="submit" className="hidden" />
      </form>
    </Sheet>
  );
}
