import { useEffect, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";

type Phase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "uptodate"; version: string }
  | { kind: "available"; update: Update; version: string }
  | { kind: "downloading"; received: number; total: number | null }
  | { kind: "error"; message: string };

/** Settings → Software updates: check GitHub releases and install in place.
 * Updating keeps all local data (database, backups, sync config) untouched. */
export default function UpdateCard() {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [current, setCurrent] = useState<string>("");

  useEffect(() => {
    void getVersion().then(setCurrent).catch(() => setCurrent(""));
  }, []);

  async function checkForUpdates() {
    setPhase({ kind: "checking" });
    try {
      const update = await check();
      if (update) {
        setPhase({ kind: "available", update, version: update.version });
      } else {
        setPhase({ kind: "uptodate", version: current });
      }
    } catch (e) {
      setPhase({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async function install(update: Update) {
    try {
      let received = 0;
      let total: number | null = null;
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            total = event.data.contentLength ?? null;
            setPhase({ kind: "downloading", received: 0, total });
            break;
          case "Progress":
            received += event.data.chunkLength;
            setPhase({ kind: "downloading", received, total });
            break;
          case "Finished":
            break;
        }
      });
      // Installer applied — restart into the new version.
      await relaunch();
    } catch (e) {
      setPhase({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <button
          className="btn-primary"
          disabled={phase.kind === "checking" || phase.kind === "downloading"}
          onClick={() => void checkForUpdates()}
        >
          {phase.kind === "checking" ? "Checking…" : "Check for updates"}
        </button>
        {current && <span className="text-xs text-zinc-600">This install: v{current}</span>}
      </div>

      {phase.kind === "uptodate" && (
        <p className="mt-2 text-xs text-zinc-500">
          You're up to date{phase.version ? ` (v${phase.version})` : ""}.
        </p>
      )}

      {phase.kind === "available" && (
        <div className="mt-2 space-y-2">
          <p className="text-xs text-zinc-300">
            Version <span className="font-medium">v{phase.version}</span> is available.
          </p>
          <button
            className="btn-primary"
            onClick={() => void install(phase.update)}
          >
            Download &amp; install, then restart
          </button>
          <p className="text-[11px] text-zinc-600">
            Your data (database, backups, sync settings) is not touched by updates.
          </p>
        </div>
      )}

      {phase.kind === "downloading" && (
        <p className="mt-2 text-xs text-sky-300">
          Downloading…{" "}
          {phase.total
            ? `${(phase.received / 1024 / 1024).toFixed(1)} / ${(phase.total / 1024 / 1024).toFixed(1)} MB`
            : `${(phase.received / 1024 / 1024).toFixed(1)} MB`}
        </p>
      )}

      {phase.kind === "error" && (
        <p className="mt-2 text-xs text-red-300">{phase.message}</p>
      )}
    </div>
  );
}
