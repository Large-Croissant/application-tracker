import { useEffect, useMemo, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import * as api from "../lib/api";
import { copyText } from "../lib/clipboard";
import { formatSalary } from "../lib/salary";
import {
  formatWhen,
  isPlanned,
  joinDateTime,
  splitDateTime,
  todayLocal,
} from "../lib/datetime";
import {
  CORRESPONDENCE_KINDS,
  STATUSES,
  correspondenceKindMeta,
  eventKindMeta,
  statusMeta,
  type Application,
  type ApplicationCorrespondence,
  type ApplicationEvent,
  type CorrespondenceKind,
} from "../types";

interface Props {
  app: Application;
  onClose: () => void;
  onEdit: (app: Application) => void;
  onDelete: (app: Application) => void;
  /** Fires after progression changes the application (inline status, bump). */
  onUpdated: (app: Application) => void;
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <div className="text-xs font-medium text-zinc-500">{label}</div>
      <div className="mt-0.5 text-sm text-zinc-200">{value}</div>
    </div>
  );
}

type Tab = "overview" | "correspondence" | "timeline";

/** Shared correspondence form state (add form and edit form look alike). */
interface Draft {
  kind: string;
  date: string;
  time: string;
  meetingMode: string;
  body: string;
  bumpStatus: string;
}

function blankDraft(): Draft {
  return { kind: "email", date: todayLocal(), time: "", meetingMode: "", body: "", bumpStatus: "" };
}

function draftFrom(item: ApplicationCorrespondence): Draft {
  const { date, time } = splitDateTime(item.occurredAt);
  return {
    kind: item.kind,
    date,
    time,
    meetingMode: item.meetingMode ?? "",
    body: item.body,
    bumpStatus: "",
  };
}

function bodyPlaceholder(kind: string): string {
  switch (kind) {
    case "call":
      return "What was discussed?…";
    case "meeting":
      return "What was discussed / what did you cover?…";
    default:
      return "Paste the full email here…";
  }
}

export default function DetailDrawer({
  app,
  onClose,
  onEdit,
  onDelete,
  onUpdated,
}: Props) {
  const [tab, setTab] = useState<Tab>("overview");
  const [events, setEvents] = useState<ApplicationEvent[]>([]);
  const [items, setItems] = useState<ApplicationCorrespondence[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Inline progression state
  const [busyStatus, setBusyStatus] = useState(false);

  // Add-correspondence form
  const [draft, setDraft] = useState<Draft>(blankDraft);
  const [savingItem, setSavingItem] = useState(false);

  // Edit-correspondence form (inline, used to fill in outcomes after the fact)
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<Draft | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);

  // Timeline composer state (notes only — everything else logs automatically)
  const [noteDate, setNoteDate] = useState(todayLocal());
  const [noteTime, setNoteTime] = useState("");
  const [eventNote, setEventNote] = useState("");
  const [savingEvent, setSavingEvent] = useState(false);

  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.listEvents(app.id), api.listCorrespondence(app.id)])
      .then(([eventList, itemList]) => {
        if (!cancelled) {
          setEvents(eventList);
          setItems(itemList);
          setLoadError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) setLoadError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [app.id]);

  async function refreshData() {
    try {
      const [eventList, itemList] = await Promise.all([
        api.listEvents(app.id),
        api.listCorrespondence(app.id),
      ]);
      setEvents(eventList);
      setItems(itemList);
    } catch {
      // Non-fatal: the drawer keeps showing the previous data.
    }
  }

  async function setError(err: unknown) {
    setLoadError(err instanceof Error ? err.message : String(err));
  }

  function flashCopied(key: string) {
    setCopiedKey(key);
    setTimeout(() => setCopiedKey((cur) => (cur === key ? null : cur)), 2000);
  }

  /** Inline status change from the drawer header — no Edit modal involved.
   * The backend logs the status_change timeline event automatically. */
  async function handleStatusChange(newStatus: string) {
    if (busyStatus || newStatus === app.status) return;
    setBusyStatus(true);
    try {
      const updated = await api.updateApplication(app.id, {
        ...api.applicationToInput(app),
        status: newStatus,
      });
      onUpdated(updated);
      await refreshData();
    } catch (err) {
      await setError(err);
    } finally {
      setBusyStatus(false);
    }
  }

  /** Applies the requested status bump by going through updateApplication,
   * which auto-logs the status_change event. */
  async function applyStatusBump(newStatus: string) {
    if (!newStatus || newStatus === app.status) return false;
    const updated = await api.updateApplication(app.id, {
      ...api.applicationToInput(app),
      status: newStatus,
    });
    onUpdated(updated);
    return true;
  }

  async function handleAddItem(e: FormEvent) {
    e.preventDefault();
    setSavingItem(true);
    try {
      const kind = draft.kind as CorrespondenceKind;
      const rawWhen = joinDateTime(draft.date, draft.time);
      await api.addCorrespondence(app.id, {
        kind,
        occurredAt: rawWhen || null,
        meetingMode: kind === "meeting" && draft.meetingMode ? draft.meetingMode : null,
        body: draft.body,
        followUpStatus: draft.bumpStatus || null,
      });
      await refreshData();
      if (draft.bumpStatus && draft.bumpStatus !== app.status) {
        const apps = await api.listApplications();
        const fresh = apps.find((a) => a.id === app.id);
        if (fresh) onUpdated(fresh);
      }
      setDraft({
        ...blankDraft(),
        // Keep the last used type — consecutive emails are the common case.
        kind,
      });
      setLoadError(null);
    } catch (err) {
      await setError(err);
    } finally {
      setSavingItem(false);
    }
  }

  function startEditItem(item: ApplicationCorrespondence) {
    setEditingId(item.id);
    setEditDraft(draftFrom(item));
  }

  async function handleSaveEdit() {
    if (!editDraft || editingId === null) return;
    setSavingEdit(true);
    try {
      const kind = editDraft.kind as CorrespondenceKind;
      const rawWhen = joinDateTime(editDraft.date, editDraft.time);
      await api.updateCorrespondence(editingId, {
        kind,
        occurredAt: rawWhen || null,
        meetingMode: kind === "meeting" && editDraft.meetingMode ? editDraft.meetingMode : null,
        body: editDraft.body,
        followUpStatus: null,
      });
      await applyStatusBump(editDraft.bumpStatus);
      setEditingId(null);
      setEditDraft(null);
      await refreshData();
      setLoadError(null);
    } catch (err) {
      await setError(err);
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleDeleteItem(id: number) {
    try {
      await api.deleteCorrespondence(id);
      setItems((prev) => prev.filter((it) => it.id !== id));
      // The linked timeline event travels with it.
      setEvents((prev) => prev.filter((ev) => ev.correspondenceId !== id));
      if (editingId === id) {
        setEditingId(null);
        setEditDraft(null);
      }
    } catch (err) {
      await setError(err);
    }
  }

  async function handleCopyItem(item: ApplicationCorrespondence, key: string) {
    const ok = await copyText(item.body);
    if (ok) {
      flashCopied(key);
    } else {
      await setError("Could not access the clipboard.");
    }
  }

  async function handleAddNote(e: FormEvent) {
    e.preventDefault();
    setSavingEvent(true);
    try {
      const created = await api.addEvent(app.id, {
        occurredAt: joinDateTime(noteDate, noteTime) || null,
        kind: "note",
        note: eventNote,
      });
      setEvents((prev) => [created, ...prev]);
      setEventNote("");
      setNoteDate(todayLocal());
      setNoteTime("");
    } catch (err) {
      await setError(err);
    } finally {
      setSavingEvent(false);
    }
  }

  async function handleDeleteEvent(ev: ApplicationEvent) {
    try {
      if (typeof ev.correspondenceId === "number") {
        // Deleting a linked entry removes the stored item too; the timeline
        // record travels with it (see delete_correspondence).
        await api.deleteCorrespondence(ev.correspondenceId);
        setItems((prev) => prev.filter((it) => it.id !== ev.correspondenceId));
        setEvents((prev) =>
          prev.filter((e2) => e2.id !== ev.id && e2.correspondenceId !== ev.correspondenceId),
        );
      } else {
        await api.deleteEvent(ev.id);
        setEvents((prev) => prev.filter((e2) => e2.id !== ev.id));
      }
    } catch (err) {
      await setError(err);
    }
  }

  const status = statusMeta(app.status);

  // Planned items first (soonest first), then history (most recent first).
  const { upcoming, history } = useMemo(() => {
    const planned = items.filter((it) => isPlanned(it.occurredAt));
    planned.sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0));
    const past = items.filter((it) => !isPlanned(it.occurredAt));
    return { upcoming: planned, history: past };
  }, [items]);

  const tabs: { id: Tab; label: string; planned: number }[] = [
    { id: "overview", label: "Overview", planned: 0 },
    { id: "correspondence", label: "Correspondence", planned: upcoming.length },
    { id: "timeline", label: "Timeline", planned: events.filter((ev) => isPlanned(ev.occurredAt)).length },
  ];

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />

      <aside className="relative z-10 flex h-full w-full max-w-lg flex-col border-l border-zinc-800 bg-zinc-900 shadow-2xl">
        {/* Header */}
        <div className="border-b border-zinc-800 px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-zinc-100">{app.company}</h2>
              <p className="text-sm text-zinc-400">{app.role}</p>
            </div>
            <button className="btn-ghost px-2" onClick={onClose} aria-label="Close">
              ✕
            </button>
          </div>

          {/* Inline progression: status lives here, not behind the Edit modal */}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2">
              <span className="text-xs font-medium text-zinc-500">Status</span>
              <select
                className="input max-w-36 px-2 py-1 text-xs"
                value={String(app.status)}
                disabled={busyStatus}
                onChange={(e) => handleStatusChange(e.target.value)}
                aria-label="Application status"
              >
                {STATUSES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
              {busyStatus && <span className="text-xs text-zinc-500">saving…</span>}
            </label>

            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${status.badge}`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
              {status.label}
            </span>

            <span className="ml-auto flex items-center gap-2">
              <button className="btn-ghost px-3 py-1.5 text-xs" onClick={() => onEdit(app)}>
                Edit
              </button>
              <button
                className="btn-danger px-3 py-1.5 text-xs"
                onClick={() => onDelete(app)}
              >
                Delete
              </button>
            </span>
          </div>

          <p className="mt-1.5 text-[11px] text-zinc-600">
            Edit is only for listing details (pay, link, contact…). Progression
            lives here.
          </p>

          {/* Tab strip — Correspondence before Timeline: it's the active surface */}
          <div className="mt-2 flex gap-1">
            {tabs.map((t) => (
              <button
                key={t.id}
                className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  tab === t.id
                    ? "bg-zinc-800 text-zinc-100"
                    : "text-zinc-500 hover:text-zinc-300"
                }`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
                {t.planned > 0 && (
                  <span className="rounded-full bg-amber-500/15 px-1.5 text-[10px] font-semibold text-amber-300">
                    {t.planned}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loadError && (
            <div className="mb-3 rounded-md border border-red-900 bg-red-950/50 px-3 py-2 text-sm text-red-300">
              {loadError}
            </div>
          )}

          {tab === "overview" && (
            <div className="space-y-5">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Pay" value={formatSalary(app, { compact: true })} />
                <Field
                  label="Applied"
                  value={app.appliedAt ? formatWhen(app.appliedAt) : "—"}
                />
                <Field label="Source" value={app.source || "—"} />
                <Field label="Location" value={app.location || "—"} />
                <Field label="Work mode" value={app.workMode || "—"} />
                <Field label="Contact" value={app.contactName || "—"} />
                <Field label="Contact email" value={app.contactEmail || "—"} />
                <Field
                  label="Posting"
                  value={
                    app.postingUrl ? (
                      <a
                        href={app.postingUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-sky-400 hover:underline"
                      >
                        Open posting ↗
                      </a>
                    ) : (
                      "—"
                    )
                  }
                />
                <Field
                  label="Follow up"
                  value={app.nextFollowupAt ? formatWhen(app.nextFollowupAt) : "—"}
                />
              </div>

              {(app.notes || "").trim() !== "" && (
                <div>
                  <div className="text-xs font-medium text-zinc-500">Notes</div>
                  <p className="mt-1 text-sm whitespace-pre-wrap text-zinc-300">{app.notes}</p>
                </div>
              )}

              {(app.postingText || "").trim() !== "" && (
                <div>
                  <div className="text-xs font-medium text-zinc-500">Saved posting text</div>
                  <p className="mt-1 text-sm whitespace-pre-wrap text-zinc-300">
                    {app.postingText}
                  </p>
                </div>
              )}
            </div>
          )}

          {tab === "correspondence" && (
            <div className="space-y-4">
              {/* Add form */}
              <form
                onSubmit={handleAddItem}
                className="space-y-2 rounded-md border border-zinc-800 bg-zinc-900/60 p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  {/* Type */}
                  <select
                    className="input max-w-28 px-2 py-1 text-xs"
                    value={draft.kind}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        kind: e.target.value,
                        meetingMode:
                          e.target.value === "meeting" && !d.meetingMode
                            ? "virtual"
                            : e.target.value === "meeting"
                              ? d.meetingMode
                              : "",
                      }))
                    }
                    aria-label="Correspondence type"
                  >
                    {CORRESPONDENCE_KINDS.map((k) => (
                      <option key={k.value} value={k.value}>
                        {k.label}
                      </option>
                    ))}
                  </select>
                  {/* When */}
                  <input
                    type="date"
                    className="input max-w-36 px-2 py-1 text-xs"
                    value={draft.date}
                    onChange={(e) => setDraft((d) => ({ ...d, date: e.target.value }))}
                    aria-label="Date"
                  />
                  <input
                    type="time"
                    className="input max-w-28 px-2 py-1 text-xs"
                    value={draft.time}
                    onChange={(e) => setDraft((d) => ({ ...d, time: e.target.value }))}
                    aria-label="Time (optional)"
                    title="Time (optional)"
                  />
                  {/* Meeting mode */}
                  {draft.kind === "meeting" && (
                    <select
                      className="input max-w-28 px-2 py-1 text-xs"
                      value={draft.meetingMode}
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, meetingMode: e.target.value }))
                      }
                      aria-label="Meeting mode"
                    >
                      <option value="">Mode…</option>
                      <option value="virtual">Virtual</option>
                      <option value="in_person">In person</option>
                    </select>
                  )}
                  {/* Status bump */}
                  <select
                    className="input ml-auto max-w-44 px-2 py-1 text-xs"
                    value={draft.bumpStatus}
                    onChange={(e) => setDraft((d) => ({ ...d, bumpStatus: e.target.value }))}
                    aria-label="Status change with this item"
                    title="Optionally move the application's status when saving"
                  >
                    <option value="">Don’t change status</option>
                    {STATUSES.map((s) => (
                      <option key={s.value} value={s.value}>
                        → {s.label}
                      </option>
                    ))}
                  </select>
                </div>
                <textarea
                  className="input min-h-20 resize-y"
                  value={draft.body}
                  onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
                  placeholder={bodyPlaceholder(draft.kind)}
                />
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-zinc-600">
                    Future date/time = planned — fill in the outcome afterwards.
                  </span>
                  <button
                    type="submit"
                    className="btn-primary"
                    disabled={savingItem || draft.body.trim() === ""}
                  >
                    {savingItem ? "Saving…" : "Save"}
                  </button>
                </div>
              </form>

              {/* Upcoming (planned) */}
              {upcoming.length > 0 && (
                <section className="space-y-2">
                  <h3 className="text-xs font-semibold text-amber-300">Upcoming</h3>
                  <ul className="space-y-2">
                    {upcoming.map((item) => (
                      <CorrespondenceCard
                        key={item.id}
                        item={item}
                        planned
                        copiedKey={copiedKey}
                        copyKey={`c-${item.id}`}
                        onCopy={() => handleCopyItem(item, `c-${item.id}`)}
                        onDelete={() => handleDeleteItem(item.id)}
                        onEdit={() => startEditItem(item)}
                        isEditing={editingId === item.id}
                        editDraft={editDraft}
                        onEditDraft={(d) => setEditDraft(d)}
                        onSaveEdit={handleSaveEdit}
                        onCancelEdit={() => {
                          setEditingId(null);
                          setEditDraft(null);
                        }}
                        savingEdit={savingEdit}
                      />
                    ))}
                  </ul>
                </section>
              )}

              {/* History */}
              <section className="space-y-2">
                <h3 className="text-xs font-semibold text-zinc-500">
                  History{history.length > 0 ? ` (${history.length})` : ""}
                </h3>
                {history.length === 0 ? (
                  <p className="text-sm text-zinc-600">
                    Nothing logged yet — paste an email or log a call or meeting.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {history.map((item) => (
                      <CorrespondenceCard
                        key={item.id}
                        item={item}
                        planned={false}
                        copiedKey={copiedKey}
                        copyKey={`c-${item.id}`}
                        onCopy={() => handleCopyItem(item, `c-${item.id}`)}
                        onDelete={() => handleDeleteItem(item.id)}
                        onEdit={() => startEditItem(item)}
                        isEditing={editingId === item.id}
                        editDraft={editDraft}
                        onEditDraft={(d) => setEditDraft(d)}
                        onSaveEdit={handleSaveEdit}
                        onCancelEdit={() => {
                          setEditingId(null);
                          setEditDraft(null);
                        }}
                        savingEdit={savingEdit}
                      />
                    ))}
                  </ul>
                )}
              </section>
            </div>
          )}

          {tab === "timeline" && (
            <div className="space-y-3">
              {/* Notes-only composer — correspondence and status changes log themselves */}
              <form onSubmit={handleAddNote} className="space-y-2">
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs font-medium text-zinc-300`}
                  >
                    <span className="h-1.5 w-1.5 rounded-full bg-zinc-400" />
                    Note
                  </span>
                  <input
                    type="date"
                    className="input max-w-36 px-2 py-1 text-xs"
                    value={noteDate}
                    onChange={(e) => setNoteDate(e.target.value)}
                    aria-label="Note date"
                  />
                  <input
                    type="time"
                    className="input max-w-28 px-2 py-1 text-xs"
                    value={noteTime}
                    onChange={(e) => setNoteTime(e.target.value)}
                    aria-label="Time (optional)"
                    title="Time (optional)"
                  />
                </div>
                <div className="flex gap-2">
                  <input
                    className="input"
                    value={eventNote}
                    onChange={(e) => setEventNote(e.target.value)}
                    placeholder="Something worth remembering? (optional)"
                  />
                  <button type="submit" className="btn-primary shrink-0" disabled={savingEvent}>
                    {savingEvent ? "…" : "+ Add"}
                  </button>
                </div>
              </form>

              {events.length === 0 ? (
                <p className="text-sm text-zinc-600">
                  No history yet — correspondence and status changes show up here automatically.
                </p>
              ) : (
                <ul className="space-y-2">
                  {events.map((ev) => {
                    const km = eventKindMeta(ev.kind);
                    const linked =
                      typeof ev.correspondenceId === "number"
                        ? items.find((it) => it.id === ev.correspondenceId)
                        : undefined;
                    const plannedEvent = isPlanned(ev.occurredAt);
                    const copyKey = `ev-${ev.id}`;
                    return (
                      <li
                        key={ev.id}
                        className="group flex items-start gap-2.5 rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-2"
                      >
                        <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${km.dot}`} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-medium text-zinc-400">
                              {km.label}
                              {linked && typeof linked.meetingMode === "string" && (
                                <span className="text-zinc-600">
                                  {" "}
                                  ·{" "}
                                  {linked.meetingMode === "in_person" ? "In person" : "Virtual"}
                                </span>
                              )}{" "}
                              · {formatWhen(ev.occurredAt)}
                            </span>
                            <span className="flex items-center gap-2">
                              {plannedEvent && (
                                <span className="rounded-full bg-amber-500/15 px-1.5 text-[10px] font-semibold text-amber-300">
                                  Planned
                                </span>
                              )}
                              <button
                                className="text-xs text-zinc-700 opacity-0 transition-opacity group-hover:opacity-100 hover:text-red-300"
                                onClick={() => handleDeleteEvent(ev)}
                                aria-label="Delete entry"
                                title={
                                  linked ? "Delete correspondence + entry" : "Delete event"
                                }
                              >
                                ✕
                              </button>
                            </span>
                          </div>

                          {linked ? (
                            /* Correspondence entry: preview + expandable body + copy */
                            <details className="mt-0.5">
                              <summary className="cursor-pointer text-sm text-zinc-300 marker:text-zinc-600">
                                <span className="line-clamp-1">{ev.note || "(details)"}</span>
                              </summary>
                              <p className="mt-1.5 text-sm whitespace-pre-wrap text-zinc-300">
                                {linked.body}
                              </p>
                              <button
                                className="btn-ghost mt-1.5 px-2 py-0.5 text-xs"
                                onClick={() => {
                                  copyText(linked.body).then((ok) => {
                                    if (ok) flashCopied(copyKey);
                                    else setError("Could not access the clipboard.");
                                  });
                                }}
                                title="Copy full text"
                              >
                                {copiedKey === copyKey ? "Copied ✓" : "Copy"}
                              </button>
                            </details>
                          ) : (
                            ev.note && (
                              <p className="text-sm whitespace-pre-wrap text-zinc-300">
                                {ev.note}
                              </p>
                            )
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

/** One correspondence card — collapsed when idle, full editor when editing.
 * Used for both the Upcoming (planned) and History sections. */
function CorrespondenceCard({
  item,
  planned,
  copiedKey,
  copyKey,
  onCopy,
  onDelete,
  onEdit,
  isEditing,
  editDraft,
  onEditDraft,
  onSaveEdit,
  onCancelEdit,
  savingEdit,
}: {
  item: ApplicationCorrespondence;
  planned: boolean;
  copiedKey: string | null;
  copyKey: string;
  onCopy: () => void;
  onDelete: () => void;
  onEdit: () => void;
  isEditing: boolean;
  editDraft: Draft | null;
  onEditDraft: (d: Draft) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  savingEdit: boolean;
}) {
  const km = correspondenceKindMeta(item.kind);
  const event = isPlanned(item.occurredAt);

  if (isEditing && editDraft) {
    const kind = editDraft.kind as CorrespondenceKind;
    return (
      <li className="rounded-md border border-sky-800/60 bg-zinc-900 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="input max-w-28 px-2 py-1 text-xs"
            value={editDraft.kind}
            onChange={(e) =>
              onEditDraft({
                ...editDraft,
                kind: e.target.value,
                meetingMode:
                  e.target.value === "meeting"
                    ? editDraft.meetingMode || "virtual"
                    : "",
              })
            }
            aria-label="Correspondence type"
          >
            {CORRESPONDENCE_KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
          <input
            type="date"
            className="input max-w-36 px-2 py-1 text-xs"
            value={editDraft.date}
            onChange={(e) => onEditDraft({ ...editDraft, date: e.target.value })}
            aria-label="Date"
          />
          <input
            type="time"
            className="input max-w-28 px-2 py-1 text-xs"
            value={editDraft.time}
            onChange={(e) => onEditDraft({ ...editDraft, time: e.target.value })}
            aria-label="Time (optional)"
          />
          {kind === "meeting" && (
            <select
              className="input max-w-28 px-2 py-1 text-xs"
              value={editDraft.meetingMode}
              onChange={(e) => onEditDraft({ ...editDraft, meetingMode: e.target.value })}
              aria-label="Meeting mode"
            >
              <option value="">Mode…</option>
              <option value="virtual">Virtual</option>
              <option value="in_person">In person</option>
            </select>
          )}
          <select
            className="input ml-auto max-w-44 px-2 py-1 text-xs"
            value={editDraft.bumpStatus}
            onChange={(e) => onEditDraft({ ...editDraft, bumpStatus: e.target.value })}
            aria-label="Status change with this item"
            title="Optionally move the application's status when saving"
          >
            <option value="">Don’t change status</option>
            {STATUSES.map((s) => (
              <option key={s.value} value={s.value}>
                → {s.label}
              </option>
            ))}
          </select>
        </div>
        <textarea
          className="input mt-2 min-h-20 resize-y"
          value={editDraft.body}
          onChange={(e) => onEditDraft({ ...editDraft, body: e.target.value })}
          placeholder={bodyPlaceholder(editDraft.kind)}
        />
        <div className="mt-2 flex justify-end gap-2">
          <button className="btn-ghost px-3 py-1 text-xs" onClick={onCancelEdit}>
            Cancel
          </button>
          <button
            className="btn-primary px-3 py-1 text-xs"
            onClick={onSaveEdit}
            disabled={savingEdit || editDraft.body.trim() === ""}
          >
            {savingEdit ? "Saving…" : "Save"}
          </button>
        </div>
      </li>
    );
  }

  return (
    <li className="group rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-zinc-400">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${km.dot}`} />
          {km.label}
          {item.meetingMode && (
            <span className="text-zinc-600">
              · {item.meetingMode === "in_person" ? "In person" : "Virtual"}
            </span>
          )}
          · {formatWhen(item.occurredAt)}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {(planned || event) && (
            <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300">
              Planned
            </span>
          )}
          <button
            className="btn-ghost px-2 py-0.5 text-xs"
            onClick={onEdit}
            title={planned ? "Edit / fill in the outcome" : "Edit"}
          >
            {planned ? "Outcome" : "Edit"}
          </button>
          <button
            className="btn-ghost px-2 py-0.5 text-xs"
            onClick={onCopy}
            title="Copy full text"
          >
            {copiedKey === copyKey ? "Copied ✓" : "Copy"}
          </button>
          <button
            className="text-xs text-zinc-700 opacity-0 transition-opacity group-hover:opacity-100 hover:text-red-300"
            onClick={onDelete}
            aria-label="Delete correspondence"
            title="Delete correspondence + its timeline entry"
          >
            ✕
          </button>
        </span>
      </div>
      <details className="mt-1">
        <summary className="cursor-pointer text-sm text-zinc-300 marker:text-zinc-600">
          <span className="line-clamp-1">
            {item.body.trim().split("\n")[0]?.trim() || "(empty)"}
          </span>
        </summary>
        <p className="mt-1.5 text-sm whitespace-pre-wrap text-zinc-300">{item.body}</p>
      </details>
    </li>
  );
}
