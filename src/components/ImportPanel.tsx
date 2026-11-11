import { useRef, useState } from "react";
import { importApplications } from "../lib/api";
import { copyText } from "../lib/clipboard";
import {
  FLOSA_SCRIPT,
  parseFlosaFile,
  type FlosaFile,
  type ParsedImport,
  type ParseStats,
} from "../lib/flosa";
import { STATUSES } from "../types";

interface Props {
  /** Refreshes the applications list after a successful import. */
  onImported: () => void;
}

const STATUS_COLORS: Record<string, string> = {
  applied: "bg-sky-400",
  acknowledged: "bg-cyan-400",
  interviewing: "bg-amber-400",
  offer: "bg-emerald-400",
  accepted: "bg-green-400",
  rejected: "bg-red-400",
  ghosted: "bg-zinc-400",
  withdrawn: "bg-zinc-500",
};

/** Settings → Import from Flosa: pick the captured JSON, review the mapping,
 * import everything in one transaction. */
export default function ImportPanel({ onImported }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [items, setItems] = useState<ParsedImport[] | null>(null);
  const [stats, setStats] = useState<ParseStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [replace, setReplace] = useState(true);
  const [copiedScript, setCopiedScript] = useState(false);

  async function pickFile(file: File) {
    setError(null);
    setResult(null);
    setItems(null);
    setStats(null);
    setFileName(file.name);
    try {
      const raw = JSON.parse(await file.text()) as FlosaFile;
      if (!Array.isArray(raw.list)) throw new Error("No application list found in this file.");
      const parsed = parseFlosaFile(raw);
      setItems(parsed.items);
      setStats(parsed.stats);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function runImport() {
    if (!items) return;
    setBusy(true);
    setError(null);
    try {
      const res = await importApplications(
        items.map((it) => ({ ...it.input, events: it.events })),
        replace,
      );
      const removedNote = res.replaced > 0 ? ` (${res.replaced} earlier Flosa rows replaced)` : "";
      setResult(
        `${res.imported} applications and ${res.events} timeline events imported.${removedNote}`,
      );
      onImported();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
      <h3 className="mb-1 text-sm font-semibold text-zinc-300">Import from Flosa</h3>
      <p className="mb-3 text-xs text-zinc-500">
        Pick the <span className="text-zinc-300">flosa_full.json</span> captured from my.flosa.app.
        You'll see a full mapping preview before anything is written.
      </p>

      {/* How to get the file — the collection script ships with the app. */}
      <div className="mb-3 rounded-md border border-zinc-800 bg-zinc-900 p-3">
        <div className="mb-2 text-xs font-medium text-zinc-400">
          Don't have the file yet? Get it from your Flosa account:
        </div>
        <ol className="mb-3 list-decimal space-y-1 pl-5 text-xs text-zinc-500">
          <li>
            Log in to <span className="text-zinc-300">my.flosa.app</span> in your browser
          </li>
          <li>
            Press <kbd className="rounded bg-zinc-800 px-1.5 text-zinc-300">F12</kbd> and open the{" "}
            <span className="text-zinc-300">Console</span> tab
          </li>
          <li>
            Paste the script below, press <span className="text-zinc-300">Enter</span>, and wait — it
            gathers every application and its history
          </li>
          <li>
            <span className="text-zinc-300">flosa_full.json</span> downloads automatically — then
            choose it below
          </li>
        </ol>
        <button
          className="btn"
          onClick={async () => {
            if (await copyText(FLOSA_SCRIPT)) {
              setCopiedScript(true);
              setTimeout(() => setCopiedScript(false), 2000);
            }
          }}
        >
          {copiedScript ? "Script copied ✓ — paste it in the console" : "Copy the Flosa export script"}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button className="btn" onClick={() => fileRef.current?.click()} disabled={busy}>
          {fileName ? `File: ${fileName}` : "Choose JSON file…"}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void pickFile(f);
            e.target.value = "";
          }}
        />
        {items && (
          <>
            <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-400">
              <input
                type="checkbox"
                checked={replace}
                onChange={(e) => setReplace(e.target.checked)}
                className="h-4 w-4 accent-zinc-600"
              />
              Replace previously imported Flosa rows
              <span className="text-zinc-600">(recommended when re-importing)</span>
            </label>
            <button className="btn-primary" onClick={() => void runImport()} disabled={busy}>
              {busy ? "Importing…" : `Import ${items.length} applications`}
            </button>
          </>
        )}
      </div>

      {error && <p className="mt-2 text-sm text-red-300">{error}</p>}
      {result && <p className="mt-2 text-sm text-emerald-300">{result}</p>}

      {stats && items && (
        <div className="mt-3 space-y-2 border-t border-zinc-800 pt-3">
          <div className="flex flex-wrap gap-2 text-xs">
            {Object.entries(stats.byStatus).map(([status, n]) => (
              <span
                key={status}
                className="inline-flex items-center gap-1.5 rounded-full bg-zinc-800 px-2 py-1 text-zinc-300"
              >
                <span className={`h-1.5 w-1.5 rounded-full ${STATUS_COLORS[status] ?? "bg-zinc-500"}`} />
                {STATUSES.find((s) => s.value === status)?.label ?? status}: {n}
              </span>
            ))}
          </div>
          <p className="text-xs text-zinc-500">
            {stats.events} timeline events will be created (status changes drive the flow chart).
            Salaries are parsed into numbers (ranges kept as ranges); the original text is stored
            in each application's notes.
          </p>
          {stats.issues.length > 0 && (
            <ul className="space-y-0.5 text-xs text-amber-300">
              {stats.issues.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          )}
          <details className="text-xs text-zinc-500">
            <summary className="cursor-pointer text-zinc-400">Preview first 10 rows</summary>
            <ul className="mt-1 space-y-0.5">
              {items.slice(0, 10).map((it, i) => (
                <li key={i} className="truncate">
                  <span className="text-zinc-300">
                    {it.input.company} — {it.input.role}
                  </span>{" "}
                  · {it.input.status} · {it.input.appliedAt ?? "no date"} ·{" "}
                  {it.milestones} milestones
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}
    </div>
  );
}
