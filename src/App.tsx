import { useCallback, useEffect, useState } from "react";
import ApplicationForm from "./components/ApplicationForm";
import ApplicationsTable from "./components/ApplicationsTable";
import * as api from "./lib/api";
import type { Application, ApplicationInput } from "./types";

const TABS = [
  { id: "applications", label: "Applications" },
  { id: "vault", label: "Vault" },
  { id: "insights", label: "Insights" },
  { id: "settings", label: "Settings" },
] as const;

type Tab = (typeof TABS)[number]["id"];

/** Placeholder panel for areas not built until later phases. */
function ComingSoon({ title, blurb }: { title: string; blurb: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900/50 p-10 text-center">
      <h2 className="text-lg font-semibold text-zinc-300">{title}</h2>
      <p className="max-w-md text-sm text-zinc-500">{blurb}</p>
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState<Tab>("applications");
  const [apps, setApps] = useState<Application[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  // Display preference, persisted locally (full "$120,000" vs compact "$120k").
  const [compactPay, setCompactPay] = useState<boolean>(
    () => localStorage.getItem("jobtracker:compactPay") === "1",
  );
  useEffect(() => {
    localStorage.setItem("jobtracker:compactPay", compactPay ? "1" : "0");
  }, [compactPay]);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Application | null>(null);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setApps(await api.listApplications());
      setLoadError(null);
    } catch (e) {
      setLoadError(String(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = apps.filter((app) => {
    if (statusFilter !== "all" && app.status !== statusFilter) return false;
    if (!search.trim()) return true;
    const needle = search.toLowerCase();
    const haystack = `${app.company} ${app.role} ${app.notes} ${app.location} ${app.contactName}`;
    return haystack.toLowerCase().includes(needle);
  });

  function openCreate() {
    setEditing(null);
    setActionError(null);
    setModalOpen(true);
  }

  function openEdit(app: Application) {
    setEditing(app);
    setActionError(null);
    setModalOpen(true);
  }

  async function handleSave(input: ApplicationInput) {
    setSaving(true);
    setActionError(null);
    try {
      if (editing) {
        await api.updateApplication(editing.id, input);
      } else {
        await api.createApplication(input);
      }
      setModalOpen(false);
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(app: Application) {
    try {
      await api.deleteApplication(app.id);
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  }

  const now = new Date();
  const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const active = apps.filter((a) =>
    ["applied", "interviewing", "offer"].includes(a.status),
  ).length;
  const thisMonth = apps.filter((a) => (a.appliedAt ?? "").startsWith(monthPrefix)).length;

  return (
    <div className="flex h-full flex-col">
      {/* Top bar */}
      <header className="flex items-center gap-6 border-b border-zinc-800 bg-zinc-900/80 px-5 py-3">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-zinc-100 text-sm font-bold text-zinc-900">
            J
          </span>
          <span className="text-sm font-semibold text-zinc-200">JobTracker</span>
        </div>
        <nav className="flex gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                tab === t.id
                  ? "bg-zinc-800 text-zinc-100"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-4 text-xs text-zinc-500">
          <span>
            <span className="font-semibold text-zinc-300">{active}</span> active
          </span>
          <span>
            <span className="font-semibold text-zinc-300">{thisMonth}</span> this month
          </span>
          {tab === "applications" && (
            <button className="btn-primary" onClick={openCreate}>
              + New application
            </button>
          )}
        </div>
      </header>

      {/* Content */}
      <main className="flex min-h-0 flex-1 flex-col gap-3 p-5">
        {loadError && (
          <div className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 text-sm text-red-300">
            Failed to load data: {loadError}
          </div>
        )}

        {tab === "applications" && (
          <>
            <div className="flex items-center gap-2">
              <input
                className="input max-w-xs"
                placeholder="Search company, role, notes…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <select
                className="input max-w-40"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
              >
                <option value="all">All statuses</option>
                {/* populated from STATUSES */}
                {(
                  [
                    "wishlist",
                    "applied",
                    "interviewing",
                    "offer",
                    "accepted",
                    "rejected",
                    "withdrawn",
                  ] as const
                ).map((s) => (
                  <option key={s} value={s}>
                    {s.charAt(0).toUpperCase() + s.slice(1)}
                  </option>
                ))}
              </select>
              <button
                className={`ml-auto text-xs ${compactPay ? "btn bg-zinc-800 text-zinc-200" : "btn-ghost"}`}
                title="Toggle pay display between $120,000 and $120k"
                onClick={() => setCompactPay((v) => !v)}
              >
                Compact pay
              </button>
            </div>

            {apps.length === 0 && !loadError ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-zinc-800 text-center">
                <div className="text-4xl">📋</div>
                <h2 className="text-lg font-semibold text-zinc-300">
                  No applications yet
                </h2>
                <p className="max-w-sm text-sm text-zinc-500">
                  Track every application's company, role, and status here — then
                  keep copies of everything you'll need to re-fill on forms.
                </p>
                <button className="btn-primary" onClick={openCreate}>
                  + Add your first application
                </button>
              </div>
            ) : (
              <ApplicationsTable
                applications={filtered}
                compactPay={compactPay}
                onEdit={openEdit}
                onDelete={handleDelete}
              />
            )}
          </>
        )}

        {tab === "vault" && (
          <ComingSoon
            title="Quick-paste Vault"
            blurb="Your profile details, references, prepared answers, and resume versions — one click to copy, ready for filling out application forms. Built in phase 3."
          />
        )}
        {tab === "insights" && (
          <ComingSoon
            title="Insights"
            blurb="Pipeline board, stats, and the flowchart view of how your applications move through stages. Built in phases 2–5."
          />
        )}
        {tab === "settings" && (
          <ComingSoon
            title="Settings & Sync"
            blurb="Dropbox connection, sync status, and data backup/export. Built in phase 4."
          />
        )}
      </main>

      {modalOpen && (
        <ApplicationForm
          editing={editing}
          saving={saving}
          error={actionError}
          onClose={() => setModalOpen(false)}
          onSave={handleSave}
        />
      )}
    </div>
  );
}
