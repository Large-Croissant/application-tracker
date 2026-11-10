import { useState } from "react";
import { STATUSES, type Application, type ApplicationInput, type Status } from "../types";

import { PAY_OPTIONS, formatAmountInput, parseAmount } from "../lib/salary";

const WORK_MODES = ["", "onsite", "hybrid", "remote"];

const SOURCES = [
  "LinkedIn",
  "Company site",
  "Indeed",
  "Referral",
  "Recruiter",
  "Job board",
  "Other",
];

function emptyInput(): ApplicationInput {
  return {
    company: "",
    role: "",
    status: "wishlist",
    source: "",
    postingUrl: "",
    location: "",
    workMode: "",
    salaryAmount: null,
    salaryCurrency: "USD",
    salaryPeriod: "",
    contactName: "",
    contactEmail: "",
    notes: "",
    postingText: "",
    appliedAt: null,
    nextFollowupAt: null,
  };
}

function fromApplication(app: Application): ApplicationInput {
  return {
    company: app.company,
    role: app.role,
    status: app.status,
    source: app.source,
    postingUrl: app.postingUrl,
    location: app.location,
    workMode: app.workMode,
    salaryAmount: app.salaryAmount,
    salaryCurrency: app.salaryCurrency,
    salaryPeriod: app.salaryPeriod,
    contactName: app.contactName,
    contactEmail: app.contactEmail,
    notes: app.notes,
    postingText: app.postingText,
    appliedAt: app.appliedAt,
    nextFollowupAt: app.nextFollowupAt,
  };
}

interface Props {
  /** Application being edited, or null for create mode. */
  editing: Application | null;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (input: ApplicationInput) => void;
}

export default function ApplicationForm({ editing, saving, error, onClose, onSave }: Props) {
  const [input, setInput] = useState(() =>
    editing ? fromApplication(editing) : emptyInput(),
  );

  const set = <K extends keyof ApplicationInput>(
    key: K,
    value: ApplicationInput[K],
  ) => setInput((prev) => ({ ...prev, [key]: value }));

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    onSave(input);
  }

  // Custom source that isn't one of the presets keeps its own text input.
  const isPresetSource = input.source === "" || SOURCES.includes(input.source);

  // Raw text shown in the pay field while typing; grouped formatting applies on blur.
  const [salaryText, setSalaryText] = useState(() =>
    editing?.salaryAmount != null ? formatAmountInput(String(editing.salaryAmount)) : "",
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-8">
      <div className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
          <h2 className="text-sm font-semibold text-zinc-200">
            {editing ? `Edit application — ${editing.company}` : "New application"}
          </h2>
          <button className="btn-ghost px-2" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {error && (
              <div className="mb-3 rounded-md border border-red-900 bg-red-950/50 px-3 py-2 text-sm text-red-300">
                {error}
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label" htmlFor="company">Company *</label>
                <input
                  id="company"
                  className="input"
                  autoFocus
                  value={input.company}
                  onChange={(e) => set("company", e.target.value)}
                  placeholder="Acme Corp"
                />
              </div>
              <div>
                <label className="label" htmlFor="role">Role *</label>
                <input
                  id="role"
                  className="input"
                  value={input.role}
                  onChange={(e) => set("role", e.target.value)}
                  placeholder="Software Engineer"
                />
              </div>

              <div>
                <label className="label" htmlFor="status">Status</label>
                <select
                  id="status"
                  className="input"
                  value={input.status}
                  onChange={(e) => set("status", e.target.value as Status)}
                >
                  {STATUSES.map((s) => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="appliedAt">Date applied</label>
                <input
                  id="appliedAt"
                  type="date"
                  className="input"
                  value={input.appliedAt ?? ""}
                  onChange={(e) => set("appliedAt", e.target.value || null)}
                />
              </div>
              <div>
                <label className="label" htmlFor="nextFollowupAt">Follow up on</label>
                <input
                  id="nextFollowupAt"
                  type="date"
                  className="input"
                  value={input.nextFollowupAt ?? ""}
                  onChange={(e) => set("nextFollowupAt", e.target.value || null)}
                />
              </div>

              <div>
                <label className="label" htmlFor="source">Source</label>
                <select
                  id="source"
                  className="input"
                  value={isPresetSource ? input.source : "__custom"}
                  onChange={(e) =>
                    e.target.value !== "__custom" && set("source", e.target.value)
                  }
                >
                  <option value="">— none —</option>
                  {SOURCES.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                  {!isPresetSource && <option value="__custom">Custom…</option>}
                </select>
                {!isPresetSource && (
                  <input
                    className="input mt-2"
                    value={input.source}
                    onChange={(e) => set("source", e.target.value)}
                    placeholder="Source name"
                  />
                )}
              </div>
              <div>
                <label className="label" htmlFor="postingUrl">Posting URL</label>
                <input
                  id="postingUrl"
                  className="input"
                  value={input.postingUrl}
                  onChange={(e) => set("postingUrl", e.target.value)}
                  placeholder="https://…"
                />
              </div>

              <div>
                <label className="label" htmlFor="location">Location</label>
                <input
                  id="location"
                  className="input"
                  value={input.location}
                  onChange={(e) => set("location", e.target.value)}
                  placeholder="New York, NY"
                />
              </div>
              <div>
                <label className="label" htmlFor="workMode">Work mode</label>
                <select
                  id="workMode"
                  className="input"
                  value={input.workMode}
                  onChange={(e) => set("workMode", e.target.value)}
                >
                  {WORK_MODES.map((m) => (
                    <option key={m} value={m}>{m === "" ? "— none —" : m}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="label" htmlFor="salaryPeriod">Pay</label>
                <select
                  id="salaryPeriod"
                  className="input"
                  value={input.salaryPeriod}
                  onChange={(e) => set("salaryPeriod", e.target.value)}
                >
                  {PAY_OPTIONS.map((p) => (
                    <option key={p.value} value={p.value}>{p.label}</option>
                  ))}
                </select>
                {input.salaryPeriod !== "" && (
                  <div className="input mt-2 flex items-center gap-1.5">
                    <span className="text-zinc-500 select-none">$</span>
                    <input
                      aria-label="Pay amount"
                      className="w-full bg-transparent outline-none placeholder:text-zinc-600"
                      value={salaryText}
                      placeholder={input.salaryPeriod === "hourly" ? "32.50" : "120k"}
                      onChange={(e) => {
                        setSalaryText(e.target.value);
                        set("salaryAmount", parseAmount(e.target.value));
                      }}
                      onBlur={() => setSalaryText(formatAmountInput(salaryText))}
                      onFocus={(e) => e.currentTarget.select()}
                    />
                  </div>
                )}
              </div>
              <div>
                <label className="label" htmlFor="contactName">Contact name</label>
                <input
                  id="contactName"
                  className="input"
                  value={input.contactName}
                  onChange={(e) => set("contactName", e.target.value)}
                  placeholder="Jane Doe (recruiter)"
                />
              </div>

              <div className="col-span-2">
                <label className="label" htmlFor="contactEmail">Contact email</label>
                <input
                  id="contactEmail"
                  className="input"
                  value={input.contactEmail}
                  onChange={(e) => set("contactEmail", e.target.value)}
                  placeholder="jane@acme.com"
                />
              </div>

              <div className="col-span-2">
                <label className="label" htmlFor="notes">Notes</label>
                <textarea
                  id="notes"
                  className="input min-h-20 resize-y"
                  value={input.notes}
                  onChange={(e) => set("notes", e.target.value)}
                  placeholder="Anything worth remembering about this application…"
                />
              </div>

              <div className="col-span-2">
                <label className="label" htmlFor="postingText">
                  Saved posting text
                </label>
                <textarea
                  id="postingText"
                  className="input min-h-24 resize-y"
                  value={input.postingText}
                  onChange={(e) => set("postingText", e.target.value)}
                  placeholder="Paste the job description here so you can re-read what you applied to…"
                />
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2 border-t border-zinc-800 px-5 py-3">
            <button type="button" className="btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving ? "Saving…" : editing ? "Save changes" : "Add application"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

type FormEvent = import("react").FormEvent;
