import { useMemo, useState } from "react";
import { statusMeta, type Application } from "../types";
import { formatSalary } from "../lib/salary";

interface Props {
  applications: Application[];
  /** Render pay amounts abbreviated ("$120k") instead of full ("$120,000"). */
  compactPay: boolean;
  onEdit: (app: Application) => void;
  onDelete: (app: Application) => void;
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

export default function ApplicationsTable({
  applications,
  compactPay,
  onEdit,
  onDelete,
}: Props) {
  const [sortKey, setSortKey] = useState<SortKey>("updatedAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  /** Row id pending deletion confirmation. */
  const [confirmingId, setConfirmingId] = useState<number | null>(null);

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
                  className="cursor-pointer border-b border-zinc-800/60 transition-colors hover:bg-zinc-800/40"
                  onClick={() => onEdit(app)}
                >
                  <td className="max-w-48 truncate px-3 py-2 font-medium text-zinc-100">
                    {app.company}
                  </td>
                  <td className="max-w-48 truncate px-3 py-2 text-zinc-300">{app.role}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${meta.badge}`}>
                      <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
                      {meta.label}
                    </span>
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
      <div className="border-t border-zinc-800 px-3 py-1.5 text-xs text-zinc-600">
        {applications.length} {applications.length === 1 ? "application" : "applications"}
      </div>
    </div>
  );
}
