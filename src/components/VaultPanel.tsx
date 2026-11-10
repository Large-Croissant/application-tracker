import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import * as api from "../lib/api";
import { copyText } from "../lib/clipboard";
import type {
  PreparedAnswer,
  ProfileField,
  ReferenceContact,
  ReferenceInput,
  ResumeVersion,
} from "../types";

type Section = "profile" | "references" | "answers" | "resumes";

const SECTIONS: { id: Section; label: string }[] = [
  { id: "profile", label: "Profile" },
  { id: "references", label: "References" },
  { id: "answers", label: "Answers" },
  { id: "resumes", label: "Resumes" },
];

/** One-click copy button with its own flash state. */
function CopyBtn({
  text,
  label = "Copy",
  disabled,
  className = "btn-ghost px-2 py-0.5 text-xs",
}: {
  text: string;
  label?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className={className}
      disabled={disabled || text.trim() === ""}
      title={text.trim() === "" ? "Nothing to copy yet" : "Copy to clipboard"}
      onClick={async () => {
        if (await copyText(text)) {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }
      }}
    >
      {copied ? "Copied ✓" : label}
    </button>
  );
}

function CardShell({
  title,
  subtitle,
  actions,
  children,
  editing,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  editing?: boolean;
}) {
  return (
    <li
      className={`rounded-md border bg-zinc-900/60 px-3 py-2 ${
        editing ? "border-sky-800/60" : "border-zinc-800"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-zinc-200">{title}</div>
          {subtitle && <div className="truncate text-xs text-zinc-500">{subtitle}</div>}
        </div>
        {actions && <span className="flex shrink-0 items-center gap-1.5">{actions}</span>}
      </div>
      {children}
    </li>
  );
}

const inputCls = "input px-2 py-1 text-xs";

export default function VaultPanel() {
  const [section, setSection] = useState<Section>("profile");
  const [loadError, setLoadError] = useState<string | null>(null);

  const [profile, setProfile] = useState<ProfileField[]>([]);
  const [references, setReferences] = useState<ReferenceContact[]>([]);
  const [answers, setAnswers] = useState<PreparedAnswer[]>([]);
  const [resumes, setResumes] = useState<ResumeVersion[]>([]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.listProfile(),
      api.listReferences(),
      api.listPreparedAnswers(),
      api.listResumes(),
    ])
      .then(([p, r, a, res]) => {
        if (!cancelled) {
          setProfile(p);
          setReferences(r);
          setAnswers(a);
          setResumes(res);
          setLoadError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) setLoadError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {loadError && (
        <div className="mb-3 rounded-md border border-red-900 bg-red-950/50 px-3 py-2 text-sm text-red-300">
          Failed to load vault: {loadError}
        </div>
      )}

      {/* Section nav */}
      <div className="mb-3 flex gap-1">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              section === s.id
                ? "bg-zinc-800 text-zinc-100"
                : "text-zinc-500 hover:text-zinc-300"
            }`}
            onClick={() => setSection(s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {section === "profile" && (
          <ProfileSection fields={profile} onChanged={setProfile} />
        )}
        {section === "references" && (
          <ReferencesSection items={references} onChanged={setReferences} />
        )}
        {section === "answers" && <AnswersSection items={answers} onChanged={setAnswers} />}
        {section === "resumes" && <ResumesSection items={resumes} onChanged={setResumes} />}
      </div>
    </div>
  );
}

/* ---------------- Profile ---------------- */

/** Fields every form on earth asks first — shown before custom ones. */
const DEFAULT_FIELDS = [
  "Full name",
  "Email",
  "Phone",
  "Location",
  "LinkedIn",
  "Portfolio / website",
];

function ProfileSection({
  fields,
  onChanged,
}: {
  fields: ProfileField[];
  onChanged: (fields: ProfileField[]) => void;
}) {
  const stored = new Map(fields.map((f) => [f.key, f.value]));
  const ordered: { key: string; value: string; custom: boolean }[] = [
    ...DEFAULT_FIELDS.map((key) => ({ key, value: stored.get(key) ?? "", custom: false })),
    ...fields
      .filter((f) => !DEFAULT_FIELDS.includes(f.key))
      .map((f) => ({ key: f.key, value: f.value, custom: true })),
  ];

  // Add-field form
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Row edit state
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editRow, setEditRow] = useState<{ key: string; value: string } | null>(null);

  /** Upserts through the backend and refreshes the list (empty value = delete). */
  async function save(key: string, value: string) {
    setSaving(true);
    try {
      await api.setProfile(key, value);
      onChanged(await api.listProfile());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    if (!newKey.trim() || !newValue.trim()) return;
    await save(newKey, newValue);
    setNewKey("");
    setNewValue("");
  }

  async function handleRowSave() {
    if (!editRow || !editingKey) return;
    await save(editRow.key, editRow.value);
    setEditingKey(null);
    setEditRow(null);
  }

  return (
    <div className="max-w-2xl space-y-3">
      {error && (
        <div className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      <p className="text-xs text-zinc-600">
        Quick-paste fields for application forms — fill them once, copy everywhere.
        Clearing a value removes the field.
      </p>

      <ul className="space-y-2">
        {ordered.map((row) =>
          editingKey === row.key ? (
            <li
              key={row.key}
              className="rounded-md border border-sky-800/60 bg-zinc-900 p-3"
            >
              <div className="flex gap-2">
                <input
                  className={`${inputCls} max-w-56`}
                  value={editRow?.key ?? ""}
                  onChange={(e) =>
                    setEditRow((r) => (r ? { ...r, key: e.target.value } : r))
                  }
                  placeholder="Field name"
                />
                <textarea
                  className={`${inputCls} min-h-12 flex-1 resize-y`}
                  value={editRow?.value ?? ""}
                  onChange={(e) =>
                    setEditRow((r) => (r ? { ...r, value: e.target.value } : r))
                  }
                  placeholder="Value to paste"
                />
              </div>
              <div className="mt-2 flex justify-end gap-2">
                <button
                  className="btn-ghost px-3 py-1 text-xs"
                  onClick={() => {
                    setEditingKey(null);
                    setEditRow(null);
                  }}
                >
                  Cancel
                </button>
                <button
                  className="btn-primary px-3 py-1 text-xs cursor-pointer"
                  onClick={handleRowSave}
                  disabled={saving}
                >
                  {saving ? "Saving…" : "Save"}
                </button>
              </div>
            </li>
          ) : (
            <li
              key={row.key}
              className="group flex items-center gap-3 rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium text-zinc-500">{row.key}</div>
                <div
                  className={`truncate text-sm ${
                    row.value ? "text-zinc-200" : "text-zinc-700 italic"
                  }`}
                  title={row.value}
                >
                  {row.value || "not filled in"}
                </div>
              </div>
              <span className="flex items-center gap-1.5">
                <CopyBtn text={row.value} />
                <button
                  className="btn-ghost px-2 py-0.5 text-xs"
                  onClick={() => {
                    setEditingKey(row.key);
                    setEditRow({ key: row.key, value: row.value });
                  }}
                  title="Edit field"
                >
                  Edit
                </button>
              </span>
            </li>
          ),
        )}
      </ul>

      {/* Add a custom field */}
      <form
        onSubmit={handleAdd}
        className="space-y-2 rounded-md border border-zinc-800 bg-zinc-900/60 p-3"
      >
        <div className="flex gap-2">
          <input
            className={`${inputCls} max-w-56`}
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            placeholder="New field name (e.g. Salary expectation)"
          />
          <input
            className={`${inputCls} flex-1`}
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
            placeholder="Value to paste"
          />
        </div>
        <div className="flex justify-end">
          <button
            type="submit"
            className="btn-primary"
            disabled={saving || !newKey.trim() || !newValue.trim()}
          >
            {saving ? "Saving…" : "+ Add field"}
          </button>
        </div>
      </form>
    </div>
  );
}

/* ---------------- References ---------------- */

function ReferenceForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: ReferenceContact | null;
  onSave: (input: ReferenceInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [form, setForm] = useState({
    name: initial?.name ?? "",
    relationship: initial?.relationship ?? "",
    title: initial?.title ?? "",
    company: initial?.company ?? "",
    email: initial?.email ?? "",
    phone: initial?.phone ?? "",
    linkedin: initial?.linkedin ?? "",
    notes: initial?.notes ?? "",
  });
  const [saving, setSaving] = useState(false);

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setSaving(true);
        try {
          await onSave(form);
        } finally {
          setSaving(false);
        }
      }}
      className="space-y-2 rounded-md border border-sky-800/60 bg-zinc-900 p-3"
    >
      <div className="grid grid-cols-2 gap-2">
        <input
          className={inputCls}
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="Name *"
        />
        <input
          className={inputCls}
          value={form.relationship}
          onChange={(e) => setForm({ ...form, relationship: e.target.value })}
          placeholder="Relationship (former manager…)"
        />
        <input
          className={inputCls}
          value={form.title}
          onChange={(e) => setForm({ ...form, title: e.target.value })}
          placeholder="Title"
        />
        <input
          className={inputCls}
          value={form.company}
          onChange={(e) => setForm({ ...form, company: e.target.value })}
          placeholder="Company"
        />
        <input
          className={inputCls}
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
          placeholder="Email"
        />
        <input
          className={inputCls}
          value={form.phone}
          onChange={(e) => setForm({ ...form, phone: e.target.value })}
          placeholder="Phone"
        />
        <input
          className={`${inputCls} col-span-2`}
          value={form.linkedin}
          onChange={(e) => setForm({ ...form, linkedin: e.target.value })}
          placeholder="LinkedIn URL"
        />
        <textarea
          className={`${inputCls} col-span-2 min-h-12 resize-y`}
          value={form.notes}
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
          placeholder="Notes (optional)"
        />
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-ghost px-3 py-1 text-xs" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="submit"
          className="btn-primary px-3 py-1 text-xs cursor-pointer"
          disabled={saving || form.name.trim() === ""}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

/** Formats a reference as a paste-ready block. */
function referenceAsText(ref: ReferenceContact): string {
  const who = [ref.title, ref.company].filter((s) => s.trim() !== "").join(", ");
  const contacts = [ref.email, ref.phone, ref.linkedin]
    .filter((s) => s.trim() !== "")
    .join(" · ");
  return [ref.name, who || undefined, contacts || undefined]
    .filter((s) => s !== undefined)
    .join("\n");
}

function ReferencesSection({
  items,
  onChanged,
}: {
  items: ReferenceContact[];
  onChanged: (items: ReferenceContact[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<unknown>) {
    try {
      await fn();
      onChanged(await api.listReferences());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
  return (
    <div className="max-w-2xl space-y-3">
      {error && (
        <div className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      {adding || editingId !== null ? (
        <ReferenceForm
          initial={editingId !== null ? items.find((r) => r.id === editingId) : null}
          onSave={async (input) => {
            await run(() =>
              editingId !== null
                ? api.updateReference(editingId, input)
                : api.addReference(input),
            );
            setAdding(false);
            setEditingId(null);
          }}
          onCancel={() => {
            setAdding(false);
            setEditingId(null);
          }}
        />
      ) : (
        <div className="flex justify-end">
          <button className="btn-primary" onClick={() => setAdding(true)}>
            + Add reference
          </button>
        </div>
      )}

      {items.length === 0 && !adding ? (
        <p className="text-sm text-zinc-600">
          No references yet — add contacts you'd list on application forms.
        </p>
      ) : (
        <ul className="space-y-2">
          {items.map((ref) => (
            <CardShell
              key={ref.id}
              title={ref.name}
              subtitle={
                [ref.relationship, ref.company].filter((s) => s.trim() !== "").join(" · ") ||
                undefined
              }
              actions={
                <>
                  <CopyBtn text={referenceAsText(ref)} label="Copy all" />
                  <button
                    className="btn-ghost px-2 py-0.5 text-xs"
                    onClick={() => setEditingId(ref.id)}
                    title="Edit"
                  >
                    Edit
                  </button>
                  <button
                    className="text-xs text-zinc-700 opacity-0 transition-opacity group-hover:opacity-100 hover:text-red-300"
                    onClick={() => run(() => api.deleteReference(ref.id))}
                    aria-label="Delete reference"
                    title="Delete reference"
                  >
                    ✕
                  </button>
                </>
              }
            >
              <div className="mt-1.5 space-y-1">
                {(
                  [
                    ["Title", ref.title],
                    ["Email", ref.email],
                    ["Phone", ref.phone],
                    ["LinkedIn", ref.linkedin],
                  ] as const
                )
                  .filter(([, v]) => v.trim() !== "")
                  .map(([k, v]) => (
                    <div key={k} className="flex items-center gap-2 text-sm">
                      <span className="w-16 shrink-0 text-xs text-zinc-600">{k}</span>
                      <span className="min-w-0 flex-1 truncate text-zinc-300">{v}</span>
                      <CopyBtn text={v} className="btn-ghost px-1.5 py-0 text-[11px]" />
                    </div>
                  ))}
                {ref.notes.trim() !== "" && (
                  <p className="pt-1 text-xs whitespace-pre-wrap text-zinc-500">{ref.notes}</p>
                )}
              </div>
            </CardShell>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ---------------- Answers ---------------- */

function AnswersSection({
  items,
  onChanged,
}: {
  items: PreparedAnswer[];
  onChanged: (items: PreparedAnswer[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState({ title: "", category: "", body: "" });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function startEdit(answer: PreparedAnswer) {
    setEditingId(answer.id);
    setDraft({ title: answer.title, category: answer.category, body: answer.body });
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      if (editingId !== null) {
        await api.updatePreparedAnswer(editingId, draft);
      } else {
        await api.addPreparedAnswer(draft);
      }
      onChanged(await api.listPreparedAnswers());
      setError(null);
      setAdding(false);
      setEditingId(null);
      setDraft({ title: "", category: "", body: "" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const form = (
    <form
      onSubmit={save}
      className="space-y-2 rounded-md border border-sky-800/60 bg-zinc-900 p-3"
    >
      <div className="flex gap-2">
        <input
          className={`${inputCls} flex-1`}
          value={draft.title}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          placeholder="Question / title *"
        />
        <input
          className={`${inputCls} max-w-44`}
          value={draft.category}
          onChange={(e) => setDraft({ ...draft, category: e.target.value })}
          placeholder="Category (optional)"
        />
      </div>
      <textarea
        className={`${inputCls} min-h-28 resize-y`}
        value={draft.body}
        onChange={(e) => setDraft({ ...draft, body: e.target.value })}
        placeholder="Paste or write the answer here…"
      />
      <div className="flex justify-end gap-2">
        <button
          type="button"
          className="btn-ghost px-3 py-1 text-xs"
          onClick={() => {
            setAdding(false);
            setEditingId(null);
          }}
        >
          Cancel
        </button>
        <button
          type="submit"
          className="btn-primary px-3 py-1 text-xs cursor-pointer"
          disabled={saving || draft.title.trim() === ""}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );

  return (
    <div className="max-w-2xl space-y-3">
      {error && (
        <div className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      {adding || editingId !== null ? (
        form
      ) : (
        <div className="flex justify-end">
          <button
            className="btn-primary"
            onClick={() => {
              setDraft({ title: "", category: "", body: "" });
              setAdding(true);
            }}
          >
            + Add answer
          </button>
        </div>
      )}

      {items.length === 0 && !adding && editingId === null ? (
        <p className="text-sm text-zinc-600">
          No prepared answers yet — save reusable answers to common form questions.
        </p>
      ) : (
        <ul>
          {items.map((answer) => (
            <CardShell
              key={answer.id}
              title={answer.title}
              subtitle={answer.category || undefined}
              actions={
                <>
                  <CopyBtn text={answer.body} />
                  <button
                    className="btn-ghost px-2 py-0.5 text-xs"
                    onClick={() => startEdit(answer)}
                    title="Edit"
                  >
                    Edit
                  </button>
                  <button
                    className="text-xs text-zinc-700 opacity-0 transition-opacity group-hover:opacity-100 hover:text-red-300"
                    onClick={async () => {
                      try {
                        await api.deletePreparedAnswer(answer.id);
                        onChanged(await api.listPreparedAnswers());
                      } catch (err) {
                        setError(err instanceof Error ? err.message : String(err));
                      }
                    }}
                    aria-label="Delete answer"
                    title="Delete answer"
                  >
                    ✕
                  </button>
                </>
              }
            >
              <details className="mt-1">
                <summary className="cursor-pointer text-sm text-zinc-300 marker:text-zinc-600">
                  <span className="line-clamp-1">{answer.body.slice(0, 120) || "(empty)"}</span>
                </summary>
                <p className="mt-1.5 text-sm whitespace-pre-wrap text-zinc-300">
                  {answer.body}
                </p>
              </details>
            </CardShell>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ---------------- Resumes ---------------- */

function ResumesSection({
  items,
  onChanged,
}: {
  items: ResumeVersion[];
  onChanged: (items: ResumeVersion[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState({ name: "", fileName: "", notes: "", content: "" });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function startEdit(resume: ResumeVersion) {
    setEditingId(resume.id);
    setDraft({
      name: resume.name,
      fileName: resume.fileName,
      notes: resume.notes,
      content: resume.content,
    });
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      if (editingId !== null) {
        await api.updateResume(editingId, draft);
      } else {
        await api.addResume(draft);
      }
      onChanged(await api.listResumes());
      setError(null);
      setAdding(false);
      setEditingId(null);
      setDraft({ name: "", fileName: "", notes: "", content: "" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const form = (
    <form
      onSubmit={save}
      className="space-y-2 rounded-md border border-sky-800/60 bg-zinc-900 p-3"
    >
      <div className="flex gap-2">
        <input
          className={`${inputCls} flex-1`}
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          placeholder="Version name * (Data resume — quant focused)"
        />
        <input
          className={`${inputCls} max-w-48`}
          value={draft.fileName}
          onChange={(e) => setDraft({ ...draft, fileName: e.target.value })}
          placeholder="File name (optional)"
        />
      </div>
      <textarea
        className={`${inputCls} min-h-40 resize-y font-mono text-[11px]`}
        value={draft.content}
        onChange={(e) => setDraft({ ...draft, content: e.target.value })}
        placeholder="Paste the resume text here — one click copies it into 'paste your resume' boxes."
      />
      <input
        className={inputCls}
        value={draft.notes}
        onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
        placeholder="Notes (optional) — which jobs this version is for"
      />
      <div className="flex justify-end gap-2">
        <button
          type="button"
          className="btn-ghost px-3 py-1 text-xs"
          onClick={() => {
            setAdding(false);
            setEditingId(null);
          }}
        >
          Cancel
        </button>
        <button
          type="submit"
          className="btn-primary px-3 py-1 text-xs cursor-pointer"
          disabled={saving || draft.name.trim() === ""}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );

  return (
    <div className="max-w-2xl space-y-3">
      {error && (
        <div className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      {adding || editingId !== null ? (
        form
      ) : (
        <div className="flex justify-end">
          <button
            className="btn-primary"
            onClick={() => {
              setDraft({ name: "", fileName: "", notes: "", content: "" });
              setAdding(true);
            }}
          >
            + Add resume version
          </button>
        </div>
      )}

      {items.length === 0 && !adding && editingId === null ? (
        <p className="text-sm text-zinc-600">
          No resume versions yet — keep each tailored version's text here to re-paste
          into forms.
        </p>
      ) : (
        <ul>
          {items.map((resume) => (
            <CardShell
              key={resume.id}
              title={resume.name}
              subtitle={resume.fileName || undefined}
              actions={
                <>
                  <CopyBtn
                    text={resume.content}
                    disabled={resume.content.trim() === ""}
                  />
                  <button
                    className="btn-ghost px-2 py-0.5 text-xs"
                    onClick={() => startEdit(resume)}
                    title="Edit"
                  >
                    Edit
                  </button>
                  <button
                    className="text-xs text-zinc-700 opacity-0 transition-opacity group-hover:opacity-100 hover:text-red-300"
                    onClick={async () => {
                      try {
                        await api.deleteResume(resume.id);
                        onChanged(await api.listResumes());
                      } catch (err) {
                        setError(err instanceof Error ? err.message : String(err));
                      }
                    }}
                    aria-label="Delete resume version"
                    title="Delete resume version"
                  >
                    ✕
                  </button>
                </>
              }
            >
              {resume.content.trim() !== "" && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-sm text-zinc-300 marker:text-zinc-600">
                    <span className="line-clamp-1">{resume.content.slice(0, 120)}…</span>
                  </summary>
                  <p className="mt-1.5 max-h-64 overflow-y-auto text-xs whitespace-pre-wrap text-zinc-300">
                    {resume.content}
                  </p>
                </details>
              )}
              {resume.notes.trim() !== "" && (
                <p className="mt-1 text-xs whitespace-pre-wrap text-zinc-500">{resume.notes}</p>
              )}
            </CardShell>
          ))}
        </ul>
      )}
    </div>
  );
}
