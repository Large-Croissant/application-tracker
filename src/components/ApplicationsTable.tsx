import { useMemo, useState } from "react";
import { statusMeta, type Application } from "../types";
import { formatSalary } from "../lib/salary";

interface Props {
  applications: Application[];
  /** Render pay amounts abbreviated ("$120k") instead of full ("$120,000"). */
  compactPay: boolean;
  /** Open the detail drawer for an application (row click). */
  onOpen: (app: Application) => void;
  onDelete: (app: Application) => void;
  /** Deletes several applications at once (bulk selection actions). */
  onDeleteMany: (apps: Application[]) => void;
}

type SortKey =
  | "company"
  | "role"
  | "status"
  | "appliedAt"
  | "source"
  | "location"
  | "salaryAmount"
  | "updatedAt";

const COLUMNS: { key: SortKey; label: string; className?: string }[] = [
  { key: "company", label: "Company" },
  { key: "role", label: "Role" },
  { key: "status", label: "Status" },
  { key: "appliedAt", label: "Applied" },
  { key: "source", label: "Source" },
  { key: "location", label: "Location" },
  { key: "salaryAmount", label: "Salary" },
  { key: "updatedAt", label: "Updated" },
];

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** Formats a bare `YYYY-MM-DD` date without timezone shenanigans. */
function formatDay(value: string): string {
  const [y, m, d] = value.split("-").map(Number);
  if (!y || !m || !d) return value;
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${MONTHS[date.getMonth()]} ${date.getDate()}`;
}

/** True when the follow-up date exists and has already passed. */
function isFollowupDue(app: Application): boolean {
  if (!app.nextFollowupAt) return false;
  return app.nextFollowupAt <= todayLocal();
}

function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function ApplicationsTable({
  applications,
  compactPay,
  onOpen,
  onDelete,
  onDeleteMany,
}: Props) {
  const [sortKey, setSortKey] = useState<SortKey>("updatedAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  /** Row id pending deletion confirmation. */
  const [confirmingId, setConfirmingId] = useState<number | null>(null);
  /** Row ids checked for bulk actions. */
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [confirmBulk, setConfirmBulk] = useState(false);

  const sorted = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    return [...applications].sort((a, b) => {
      const av = a[sortKey] ?? "";
      const bv = b[sortKey] ?? "";
      const cmp =
        typeof av === "number" && typeof bv === "number"
          ? av - bv
          : String(av).localeCompare(String(bv));
      return cmp * dir;
    });
  }, [applications, sortKey, sortDir]);

  const selectedApps = useMemo(
    () => sorted.filter((a) => selected.has(a.id)),
    [sorted, selected],
  );
  const allChecked = sorted.length > 0 && selectedApps.length === sorted.length;

  function toggleAll() {
    if (allChecked) setSelected(new Set());
    else setSelected(new Set(sorted.map((a) => a.id)));
    setConfirmBulk(false);
  }

  function toggleOne(id: number) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setConfirmBulk(false);
  }

  function handleBulkDelete() {
    if (selectedApps.length === 0) return;
    if (!confirmBulk) {
      setConfirmBulk(true);
      setTimeout(() => setConfirmBulk(false), 4000);
      return;
    }
    onDeleteMany(selectedApps);
    setSelected(new Set());
    setConfirmBulk(false);
  }

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "company" || key === "role" ? "asc" : "desc");
    }
  }

  function handleDelete(app: Application) {
    if (confirmingId === app.id) {
      onDelete(app);
      setConfirmingId(null);
    } else {
      setConfirmingId(app.id);
      // Reset the confirmation if the user moves on without deciding.
      setTimeout(() => setConfirmingId((cur) => (cur === app.id ? null : cur)), 4000);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/50">
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 z-10 bg-zinc-900 text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="w-10 border-b border-zinc-800 px-3 py-2">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-zinc-500"
                  checked={allChecked}
                  onChange={toggleAll}
                  title="Select all"
                  aria-label="Select all applications"
                />
              </th>
              {COLUMNS.map((col) => (
                <th
                  key={col.key}
                  className="cursor-pointer border-b border-zinc-800 px-3 py-2 font-medium whitespace-nowrap select-none hover:text-zinc-300"
                  onClick={() => toggleSort(col.key)}
                >
                  {col.label}
                  {sortKey === col.key && (
                    <span className="ml-1 text-zinc-400">
                      {sortDir === "asc" ? "▲" : "▼"}
                    </span>
                  )}
                </th>
              ))}
              <th className="w-10 border-b border-zinc-800 px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((app) => {
              const meta = statusMeta(app.status);
              return (
                <tr
                  key={app.id}
                  className={`cursor-pointer border-b border-zinc-800/60 transition-colors hover:bg-zinc-800/40 ${
                    selected.has(app.id) ? "bg-sky-950/40" : ""
                  }`}
                  onClick={() => onOpen(app)}
                >
                  <td
                    className="px-3 py-2"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-zinc-500"
                      checked={selected.has(app.id)}
                      onChange={() => toggleOne(app.id)}
                      aria-label={`Select ${app.company} application`}
                    />
                  </td>
                  <td className="max-w-48 truncate px-3 py-2 font-medium text-zinc-100">
                    {app.company}
                  </td>
                  <td className="max-w-48 truncate px-3 py-2 text-zinc-300">{app.role}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${meta.badge}`}>
                      <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
                      {meta.label}
                    </span>
                    {isFollowupDue(app) && (
                      <span
                        className="ml-2 inline-flex items-center rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-300"
                        title={`Follow-up date reached (${app.nextFollowupAt})`}
                      >
                        Follow up
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-zinc-400 whitespace-nowrap">
                    {app.appliedAt ? formatDay(app.appliedAt) : "—"}
                  </td>
                  <td className="max-w-32 truncate px-3 py-2 text-zinc-400">{app.source}</td>
                  <td className="max-w-40 truncate px-3 py-2 text-zinc-400">
                    {app.location || app.workMode || "—"}
                  </td>
                  <td className="px-3 py-2 text-zinc-400 whitespace-nowrap">
                    {formatSalary(app, { compact: compactPay })}
                  </td>
                  <td className="px-3 py-2 text-zinc-500 whitespace-nowrap">
                    {formatTimestamp(app.updatedAt)}
                  </td>
                  <td className="px-3 py-2 text-right" onClick={(e) => e.stopPropagation()}>
                    {confirmingId === app.id ? (
                      <button
                        className="btn-danger px-2 py-1 text-xs"
                        onClick={() => handleDelete(app)}
                        title="Click again to confirm"
                      >
                        Delete?
                      </button>
                    ) : (
                      <button
                        className="btn-ghost px-2 py-1 text-xs text-zinc-600 hover:text-red-300"
                        onClick={() => handleDelete(app)}
                        aria-label={`Delete ${app.company} application`}
                        title="Delete"
                      >
                        ✕
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {selectedApps.length > 0 && (
        <div className="flex items-center justify-between border-t border-zinc-800 bg-zinc-900 px-3 py-2 text-xs">
          <span className="text-zinc-300">
            {selectedApps.length} selected
          </span>
          <span className="flex items-center gap-2">
            <button
              className="btn-ghost px-2 py-1"
              onClick={() => {
                setSelected(new Set());
                setConfirmBulk(false);
              }}
            >
              Clear
            </button>
            <button
              className={confirmBulk ? "btn-danger px-3 py-1" : "btn px-3 py-1"}
              onClick={handleBulkDelete}
            >
              {confirmBulk ? "Click again to confirm" : "Delete selected"}
            </button>
          </span>
        </div>
      )}
      <div className="border-t border-zinc-800 px-3 py-1.5 text-xs text-zinc-600">
        {applications.length} {applications.length === 1 ? "application" : "applications"}
      </div>
    </div>
  );
}
