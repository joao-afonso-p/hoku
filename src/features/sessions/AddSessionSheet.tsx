import { useEffect, useState } from "react";
import { closeOverlay, reload, select, toast, focusProject } from "../../app/actions";
import { UNSORTED } from "../../app/model";
import { useHub } from "../../app/store";
import { Field, Sheet } from "../../components/Sheet";
import { api } from "../../lib/api";
import type { HubError, ParsedReference, Provider } from "../../lib/types";
import { PROVIDER_LIST, PROVIDERS } from "../../providers";
import { GlyphIcon } from "../constellation/Glyph";

export function AddSessionSheet({ projectId }: { projectId?: string | null }) {
  const projects = useHub((s) => s.data.projects);
  const accounts = useHub((s) => s.data.accounts);
  const [provider, setProvider] = useState<Provider>("claude");
  const [reference, setReference] = useState("");
  const [title, setTitle] = useState("");
  const [project, setProject] = useState<string>(projectId && projectId !== UNSORTED ? projectId : "");
  const [account, setAccount] = useState<string>("");
  const [dir, setDir] = useState("");
  const [notes, setNotes] = useState("");
  const [parsed, setParsed] = useState<ParsedReference | null>(null);
  const [parseError, setParseError] = useState<HubError | null>(null);
  const [error, setError] = useState<HubError | null>(null);
  const [busy, setBusy] = useState(false);
  const desc = PROVIDERS[provider];
  const accountOptions = accounts.filter((a) => a.provider === (provider === "codex" ? "codex" : "claude"));

  // Live, debounced validation of the pasted reference.
  useEffect(() => {
    setParsed(null);
    setParseError(null);
    if (!reference.trim()) return;
    const t = window.setTimeout(async () => {
      try {
        setParsed(await api.parseReference(provider, reference));
      } catch (e) {
        setParseError(e as HubError);
      }
    }, 180);
    return () => window.clearTimeout(t);
  }, [reference, provider]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const s = await api.addManualSession({
        provider,
        reference,
        title,
        projectId: project || null,
        providerAccountId: account || null,
        workingDirectory: desc.needsWorkingDirectory ? dir : null,
        notes: notes || null,
      });
      await reload();
      closeOverlay();
      focusProject(s.projectId ?? UNSORTED);
      select(s.id);
      toast({ tone: "success", message: `Added “${s.title}”` });
    } catch (e) {
      setError(e as HubError);
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = !!parsed && title.trim().length > 0 && (!desc.needsWorkingDirectory || dir.trim().length > 0) && !busy;

  return (
    <Sheet
      title="Add a session"
      subtitle="For conversations that can’t be discovered automatically."
      width={480}
      footer={
        <>
          <button className="btn btn-ghost" onClick={closeOverlay}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!canSubmit} onClick={() => void submit()}>
            Add session
          </button>
        </>
      }
    >
      <form
        className="space-y-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) void submit();
        }}
      >
        <div className="grid grid-cols-3 gap-1 rounded-[9px] border border-line bg-white/[0.02] p-1">
          {PROVIDER_LIST.map((p) => (
            <button
              type="button"
              key={p.id}
              onClick={() => setProvider(p.id)}
              className={`flex h-8 items-center justify-center gap-2 rounded-[6px] text-[12.5px] transition-colors ${
                provider === p.id ? "bg-white/[0.08] text-ink" : "text-ink-3 hover:text-ink-2"
              }`}
            >
              <GlyphIcon kind={p.glyph} color={p.accent} size={10} />
              {p.label}
            </button>
          ))}
        </div>

        <Field label={desc.referenceLabel}>
          <input autoFocus className="field font-mono text-[12px]" placeholder={desc.referencePlaceholder} value={reference} onChange={(e) => setReference(e.target.value)} spellCheck={false} />
          <div className="mt-1.5 min-h-[16px] text-[11.5px]">
            {parsed && (
              <span className="block truncate text-ok">
                ✓ {parsed.summary} <span className="font-mono text-ink-3">{parsed.deepLink ?? parsed.externalId}</span>
              </span>
            )}
            {parseError && <span className="text-danger">{parseError.message}</span>}
          </div>
        </Field>

        <Field label="Title">
          <input className="field" placeholder="What is this conversation about?" value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>

        {desc.needsWorkingDirectory && (
          <Field label="Working directory" hint="Claude Code resumes from here">
            <input className="field font-mono text-[12px]" placeholder="~/Code/project" value={dir} onChange={(e) => setDir(e.target.value)} spellCheck={false} />
          </Field>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Project">
            <select className="field h-[34px] py-0" value={project} onChange={(e) => setProject(e.target.value)}>
              <option value="">Unsorted</option>
              {projects.filter((p) => !p.archivedAt).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Account">
            <select className="field h-[34px] py-0" value={account} onChange={(e) => setAccount(e.target.value)}>
              <option value="">{accountOptions.length ? "Default" : "Default (created on save)"}</option>
              {accountOptions.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field label="Notes" hint="optional">
          <textarea className="field min-h-[56px] resize-none" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>

        {error && (
          <div className="rounded-[8px] border border-danger/25 bg-danger/5 px-3 py-2 text-[12px] text-danger">
            {error.message}
            {error.detail && <div className="mt-0.5 font-mono text-[11px] text-ink-3">{error.detail}</div>}
          </div>
        )}
        <button type="submit" className="hidden" />
      </form>
    </Sheet>
  );
}
