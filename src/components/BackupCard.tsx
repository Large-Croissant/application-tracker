import { useEffect, useState } from "react";
import * as api from "../lib/api";
import type { BackupEntry } from "../lib/api";

/** Settings → Backups & export: local dated DB backups plus CSV export. */
export default function BackupCard() {
  const [backups, setBackups] = useState<BackupEntry[] | null>(null);
  const [days, setDays] = useState<number | null>(null);
  const [daysDraft, setDaysDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      setBackups(await api.backupList());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void refresh();
    api
      .backupGetDays()
      .then((d) => {
        setDays(d);
        setDaysDraft(String(d));
      })
      .catch(() => {});
  }, []);

  /** Saves the retention on blur/Enter; invalid or out-of-range input snaps back. */
  async function commitDays() {
    const n = Number(daysDraft);
    if (!Number.isInteger(n) || n < 1 || n > 365 || n === days) {
      setDaysDraft(days == null ? "14" : String(days));
      return;
    }
    try {
      const applied = await api.backupSetDays(n);
      setDays(applied);
      setDaysDraft(String(applied));
      setMessage(`Keeping the newest ${applied} days of backups.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setDaysDraft(days == null ? "14" : String(days));
    }
  }

  async function run(kind: "backup" | "csv" | "folder") {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      if (kind === "backup") {
        const path = await api.backupNow();
        setMessage(`Backup saved: ${path}`);
        await refresh();
      } else if (kind === "csv") {
        const path = await api.exportCsv();
        // Empty path = the save dialog was cancelled.
        if (path) setMessage(`CSV exported: ${path}`);
      } else {
        await api.revealBackupFolder();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const newest = backups?.[0];

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
      <p className="mb-3 text-xs text-zinc-600">
        {backups === null ? (
          "Checking backups…"
        ) : backups.length === 0 ? (
          <>
            A timestamped full-database backup is written here automatically
            every time you close the app — none yet.
          </>
        ) : (
          <>
            A timestamped full-database backup is written automatically every
            time you close the app. Right now:{" "}
            <span className="text-zinc-400">{backups.length}</span> backup
            {backups.length === 1 ? "" : "s"} spanning the last{" "}
            <span className="text-zinc-400">{days ?? "?"}</span> days
            (newest <span className="text-zinc-400">{newest?.name}</span>,{" "}
            {formatSize(newest?.sizeBytes ?? 0)}).
          </>
        )}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <button
          className="btn-ghost px-2 py-1 text-xs disabled:opacity-50"
          disabled={busy}
          onClick={() => run("backup")}
        >
          {busy ? "working…" : "Back up now"}
        </button>
        <button
          className="btn-ghost px-2 py-1 text-xs disabled:opacity-50"
          disabled={busy}
          onClick={() => run("folder")}
        >
          Show backup folder
        </button>
        <button
          className="btn-ghost px-2 py-1 text-xs disabled:opacity-50"
          disabled={busy}
          onClick={() => run("csv")}
        >
          Export CSV…
        </button>
        <label className="ml-auto flex items-center gap-1.5 text-xs text-zinc-500">
          Keep newest
          <input
            type="number"
            min={1}
            max={365}
            className="input w-16 px-2 py-1 text-xs"
            value={daysDraft}
            onChange={(e) => setDaysDraft(e.target.value)}
            onBlur={commitDays}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            aria-label="Days of backups to keep"
            title="Backups older than this many days are deleted (1–365)"
          />
          days of backups
        </label>
      </div>

      {message && <p className="mt-2 text-xs text-zinc-400">{message}</p>}
      {error && <p className="mt-2 text-xs text-red-300">{error}</p>}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
