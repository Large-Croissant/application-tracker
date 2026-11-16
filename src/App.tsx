import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { setTimeFormat, useTimeFormat } from "./lib/datetime";
import ApplicationForm from "./components/ApplicationForm";
import ApplicationsTable from "./components/ApplicationsTable";
import BackupCard from "./components/BackupCard";
import DetailDrawer from "./components/DetailDrawer";
import ImportPanel from "./components/ImportPanel";
import InsightsPanel from "./components/InsightsPanel";
import SampleDataCard from "./components/SampleDataCard";
import SyncPanel from "./components/SyncPanel";
import KanbanBoard from "./components/KanbanBoard";
import StatsStrip from "./components/StatsStrip";
import SyncDot from "./components/SyncDot";
import VaultPanel from "./components/VaultPanel";
import * as api from "./lib/api";
import { STATUSES, type Application, type ApplicationEvent, type ApplicationInput } from "./types";

const TABS = [
  { id: "applications", label: "Applications" },
  { id: "vault", label: "Vault" },
  { id: "insights", label: "Insights" },
  { id: "settings", label: "Settings" },
] as const;

type Tab = (typeof TABS)[number]["id"];

/** A labeled settings section: small uppercase heading, one-line hint, card body. */
function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <section>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
        {title}
      </h3>
      <p className="mt-0.5 text-xs text-zinc-600">{hint}</p>
      <div className="mt-2">{children}</div>
    </section>
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

  // Main view mode for the applications tab, also persisted.
  const [viewMode, setViewMode] = useState<"table" | "board">(
    () =>
      (localStorage.getItem("jobtracker:viewMode") as "table" | "board" | null) ??
      "table",
  );
  useEffect(() => {
    localStorage.setItem("jobtracker:viewMode", viewMode);
  }, [viewMode]);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Application | null>(null);
  const [detail, setDetail] = useState<Application | null>(null);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  /** Bumped on every data load so the sync dot re-checks its state. */
  const [dataStamp, setDataStamp] = useState(0);
  const timeFormat = useTimeFormat();

  /** Stage-history filter: show apps that were ever in this stage. */
  const [stageFilter, setStageFilter] = useState("any");
  const [allEvents, setAllEvents] = useState<ApplicationEvent[]>([]);

  const load = useCallback(async () => {
    try {
      // Events too: the "ever reached" stage filter is built from the
      // status_change trail every application carries.
      const [apps, events] = await Promise.all([
        api.listApplications(),
        api.listAllEvents(),
      ]);
      setApps(apps);
      setAllEvents(events);
      setLoadError(null);
      setDataStamp((n) => n + 1);
    } catch (e) {
      setLoadError(String(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /** app id → every stage it has demonstrably been in (status_change trail
   * "old → new" events, both endpoints, plus the current status). */
  const stagesByApp = useMemo(() => {
    const map = new Map<number, Set<string>>();
    const add = (id: number, stage: string) => {
      if (!stage) return;
      let set = map.get(id);
      if (!set) map.set(id, (set = new Set()));
      set.add(stage);
    };
    for (const ev of allEvents) {
      if (ev.kind !== "status_change") continue;
      const parts = ev.note.split(" → ");
      if (parts.length !== 2) continue;
      add(ev.applicationId, parts[0].trim());
      add(ev.applicationId, parts[1].trim());
    }
    for (const a of apps) add(a.id, a.status);
    return map;
  }, [allEvents, apps]);

  const filtered = apps.filter((app) => {
    if (statusFilter !== "all" && app.status !== statusFilter) return false;
    if (stageFilter !== "any" && !stagesByApp.get(app.id)?.has(stageFilter)) return false;
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

  /** Progression updates from the drawer (inline status, email bump). */
  async function handleUpdated(fresh: Application) {
    setApps((prev) => prev.map((a) => (a.id === fresh.id ? fresh : a)));
    setDetail((cur) => (cur?.id === fresh.id ? fresh : cur));
  }

  async function handleDelete(app: Application) {
    try {
      await api.deleteApplication(app.id);
      setDetail((cur) => (cur?.id === app.id ? null : cur));
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleMove(app: Application, toStatus: string) {
    if (app.status === toStatus) return;
    try {
      const updated = await api.updateApplication(app.id, {
        ...api.applicationToInput(app),
        status: toStatus,
      });
      setDetail((cur) => (cur?.id === updated.id ? updated : cur));
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleDeleteMany(apps: Application[]) {
    try {
      await api.deleteApplications(apps.map((a) => a.id));
      setDetail((cur) => (apps.some((a) => a.id === cur?.id) ? null : cur));
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  }

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
          <SyncDot refreshKey={dataStamp} onOpenSettings={() => setTab("settings")} />
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
            <StatsStrip applications={apps} />

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
                    "acknowledged",
                    "interviewing",
                    "offer",
                    "accepted",
                    "rejected",
                    "ghosted",
                    "withdrawn",
                  ] as const
                ).map((s) => (
                  <option key={s} value={s}>
                    {s.charAt(0).toUpperCase() + s.slice(1)}
                  </option>
                ))}
              </select>
              <select
                className="input max-w-48"
                value={stageFilter}
                onChange={(e) => setStageFilter(e.target.value)}
                aria-label="Filter by stage history"
                title="Shows applications that were ever in this stage, even if they've since moved on"
              >
                <option value="any">Ever reached: any stage</option>
                {STATUSES.map((s) => (
                  <option key={s.value} value={s.value}>
                    Ever reached: {s.label}
                  </option>
                ))}
              </select>

              {/* Table / board toggle */}
              <div className="ml-auto flex overflow-hidden rounded-md border border-zinc-700">
                {([["table", "Table"], ["board", "Board"]] as const).map(
                  ([mode, label]) => (
                    <button
                      key={mode}
                      className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                        viewMode === mode
                          ? "bg-zinc-800 text-zinc-100"
                          : "text-zinc-500 hover:text-zinc-300"
                      }`}
                      onClick={() => setViewMode(mode)}
                    >
                      {label}
                    </button>
                  ),
                )}
              </div>
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
            ) : viewMode === "board" ? (
              <KanbanBoard
                applications={filtered}
                compactPay={compactPay}
                onOpen={setDetail}
                onMove={handleMove}
              />
            ) : (
              <ApplicationsTable
                applications={filtered}
                compactPay={compactPay}
                onOpen={setDetail}
                onDelete={handleDelete}
                onDeleteMany={handleDeleteMany}
              />
            )}
          </>
        )}

        {tab === "vault" && <VaultPanel />}
        {tab === "insights" && (
          <InsightsPanel applications={apps} />
        )}
        {tab === "settings" && (
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            <div className="max-w-xl space-y-6 pb-8">
              <Section
                title="Display"
                hint="Formatting only — safe to change anytime."
              >
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
                  <label className="flex cursor-pointer items-center gap-3">
                    <input
                      type="checkbox"
                      checked={compactPay}
                      onChange={(e) => setCompactPay(e.target.checked)}
                      className="h-4 w-4 accent-zinc-600"
                    />
                    <span className="text-sm text-zinc-300">
                      Compact pay amounts
                      <span className="ml-2 text-zinc-500">
                        ($120k instead of $120,000 in the table and board)
                      </span>
                    </span>
                  </label>
                  <div className="mt-3 flex items-center gap-3">
                    <span className="text-sm text-zinc-300">Time format</span>
                    <div className="flex overflow-hidden rounded-md border border-zinc-700">
                      {(
                        [
                          ["12", "12-hour (9:30 PM)"],
                          ["24", "24-hour (21:30)"],
                        ] as const
                      ).map(([f, label]) => (
                        <button
                          key={f}
                          className={`px-3 py-1 text-xs font-medium transition-colors ${
                            timeFormat === f
                              ? "bg-zinc-800 text-zinc-100"
                              : "text-zinc-500 hover:text-zinc-300"
                          }`}
                          onClick={() => setTimeFormat(f)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </Section>

              <Section
                title="Cloud sync"
                hint="One encrypted snapshot of everything, in your own Dropbox — also pushes automatically when you close the app."
              >
                <SyncPanel onSynced={load} />
              </Section>

              <Section
                title="Backups & export"
                hint="Automatic daily local backups on close (newest 14 kept), plus CSV export for spreadsheets."
              >
                <BackupCard />
              </Section>

              <Section
                title="Data import"
                hint="Pick the flosa_full.json captured from my.flosa.app — full mapping preview before anything is written."
              >
                <ImportPanel onImported={load} />
              </Section>

              <Section
                title="Developer"
                hint="Fake data for trying out the app — never touches your real applications."
              >
                <SampleDataCard
                  sampleCount={apps.filter((a) => a.company.startsWith("Sample · ")).length}
                  onDataChanged={load}
                />
              </Section>
            </div>
          </div>
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

      {detail && (
        <DetailDrawer
          app={detail}
          onClose={() => setDetail(null)}
          onEdit={(app) => openEdit(app)}
          onDelete={handleDelete}
          onUpdated={handleUpdated}
        />
      )}
    </div>
  );
}
