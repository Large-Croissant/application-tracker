import { useState } from "react";
import * as api from "../lib/api";

/** Settings → Developer: seed or remove the 42 fake sample applications. */
export default function SampleDataCard({
  sampleCount,
  onDataChanged,
}: {
  sampleCount: number;
  onDataChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(kind: "seed" | "delete") {
    setBusy(true);
    setError(null);
    try {
      const n = kind === "seed" ? await api.seedSampleData() : await api.deleteSampleData();
      onDataChanged();
      if (kind === "delete" && n === 0) setError("No sample applications found to remove.");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
      <p className="mb-3 text-xs text-zinc-600">
        Fake rows named <span className="text-zinc-400">Sample · …</span> for trying the app
        before real data arrives. They never touch your real applications.
        {sampleCount > 0 && (
          <span className="ml-1 text-zinc-500">{sampleCount} sample rows present.</span>
        )}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          className="btn-ghost px-2 py-1 text-xs disabled:opacity-50"
          disabled={busy}
          onClick={() => run("seed")}
        >
          {busy ? "working…" : "+ Add 42 sample applications"}
        </button>
        {sampleCount > 0 && (
          <button
            className="btn-ghost px-2 py-1 text-xs disabled:opacity-50"
            disabled={busy}
            onClick={() => run("delete")}
          >
            Remove sample data
          </button>
        )}
        {error && <span className="text-xs text-red-300">{error}</span>}
      </div>
    </div>
  );
}
