import { useEffect, useState } from "react";
import * as api from "../lib/api";
import type { CloudStatus, SyncInfo } from "../lib/api";

/** Settings → Cloud sync: Dropbox OAuth connect, E2E encryption toggle,
 * and a single "Sync now" (pull-merge + push) of everything. */
export default function SyncPanel({ onSynced }: { onSynced: () => void }) {
  const [info, setInfo] = useState<SyncInfo | null>(null);
  const [appKey, setAppKey] = useState("");
  const [code, setCode] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [cloud, setCloud] = useState<CloudStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      setInfo(await api.syncGetInfo());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function run(fn: () => Promise<string | void>) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const msg = await fn();
      if (typeof msg === "string") setMessage(msg);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function connect() {
    if (!appKey.trim()) {
      setError("Paste your Dropbox app key first.");
      return;
    }
    await run(async () => {
      await api.syncSaveSettings({ appKey: appKey.trim() });
      await api.syncStartConnect();
      setAppKey("");
      return "Dropbox opened in your browser — paste the authorization code below.";
    });
  }

  async function syncNow() {
    await run(async () => {
      const msg = await api.syncCycle(passphrase || null);
      onSynced();
      return msg;
    });
  }

  async function checkCloud() {
    await run(async () => {
      const status = await api.syncCheckCloud();
      setCloud(status);
      if (!status.exists) return "No sync file in Dropbox yet — push once to create it.";
      if (status.revMatches) {
        return "Cloud file matches the last sync from this device — no conflict.";
      }
      return "⚠ The Dropbox file changed after this device's last sync — someone else pushed, or this is a new device. Sync now to merge that data here (a backup of this device's data is saved first).";
    });
  }

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
      {error && (
        <div className="mb-2 rounded-md border border-red-900 bg-red-950/50 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      )}
      {message && (
        <div className="mb-2 rounded-md border border-sky-900 bg-sky-950/40 px-3 py-2 text-xs text-sky-200">
          {message}
        </div>
      )}

      {!info && <p className="text-xs text-zinc-600">Loading…</p>}

      {info && !info.connected && (
        <div className="space-y-3">
          <details className="rounded-md border border-zinc-800 bg-zinc-900 p-3 text-xs text-zinc-500">
            <summary className="cursor-pointer text-zinc-400">
              One-time setup: create your Dropbox app (2 minutes)
            </summary>
            <ol className="mt-2 list-decimal space-y-1 pl-5">
              <li>
                Go to{" "}
                <span className="text-zinc-300">dropbox.com/developers/apps</span> →{" "}
                <span className="text-zinc-300">Create app</span>
              </li>
              <li>
                Choose <span className="text-zinc-300">Scoped access</span> →{" "}
                <span className="text-zinc-300">App folder</span> → name it{" "}
                <span className="text-zinc-300">JobTracker</span>
              </li>
              <li>
                In <span className="text-zinc-300">Permissions</span>, enable{" "}
                <span className="text-zinc-300">files.content.read</span> and{" "}
                <span className="text-zinc-300">files.content.write</span>, then Submit
              </li>
              <li>
                In <span className="text-zinc-300">Settings</span>, copy the{" "}
                <span className="text-zinc-300">App key</span> and paste it below
              </li>
            </ol>
          </details>

          {info.pendingPkce ? (
            <div className="space-y-2">
              <p className="text-xs text-zinc-400">
                Dropbox should be open in your browser. Approve access, copy the code it
                shows, and paste it here:
              </p>
              <div className="flex gap-2">
                <input
                  className={`${inputCls} flex-1`}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="Paste authorization code"
                />
                <button
                  className="btn-primary"
                  disabled={busy || !code.trim()}
                  onClick={() => void run(async () => {
                    await api.syncCompleteConnect(code);
                    setCode("");
                    return "Dropbox connected. You can push and pull now.";
                  })}
                >
                  {busy ? "…" : "Finish connecting"}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex gap-2">
              <input
                className={`${inputCls} flex-1`}
                value={appKey}
                onChange={(e) => setAppKey(e.target.value)}
                placeholder="Dropbox App key"
              />
              <button className="btn-primary" disabled={busy || !appKey.trim()} onClick={() => void connect()}>
                {busy ? "Opening…" : "Connect Dropbox"}
              </button>
            </div>
          )}
        </div>
      )}

      {info && info.connected && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-xs">
            <span className="h-2 w-2 rounded-full bg-emerald-400" />
            <span className="text-zinc-300">Connected to Dropbox</span>
            {info.lastSyncAt && (
              <span className="text-zinc-600">· last sync {info.lastSyncAt.slice(0, 16).replace("T", " ")}</span>
            )}
            <button
              className="btn-ghost ml-auto px-2 py-0.5 text-xs text-zinc-500 hover:text-red-300"
              disabled={busy}
              onClick={() => {
                if (window.confirm("Disconnect Dropbox? Sync settings are kept.")) {
                  void run(async () => {
                    await api.syncDisconnect();
                    setCloud(null);
                    return "Disconnected.";
                  });
                }
              }}
            >
              Disconnect
            </button>
          </div>

          <label className="flex cursor-pointer items-start gap-2 text-xs text-zinc-400">
            <input
              type="checkbox"
              checked={info.encrypt}
              onChange={(e) => void run(async () => {
                await api.syncSaveSettings({ encrypt: e.target.checked });
                setCloud(null);
                return undefined;
              })}
              className="mt-0.5 h-4 w-4 accent-zinc-600"
            />
            <span>
              <span className="text-zinc-200">End-to-end encryption</span> (recommended) —
              data is encrypted with your passphrase before upload; Dropbox only ever stores
              ciphertext. Unchecking means Dropbox can read your data.
            </span>
          </label>

          <label className="flex cursor-pointer items-start gap-2 text-xs text-zinc-400">
            <input
              type="checkbox"
              checked={info.autoSync}
              onChange={(e) => void run(async () => {
                await api.syncSaveSettings({ autoSync: e.target.checked });
                return undefined;
              })}
              className="mt-0.5 h-4 w-4 accent-zinc-600"
            />
            <span>
              <span className="text-zinc-200">Sync automatically on close</span> — merges any
              cloud changes and uploads a snapshot when the app exits (uses the remembered
              passphrase; skipped when there is none). Results land in the header dot next launch.
            </span>
          </label>

          {info.encrypt && (
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="password"
                className={`${inputCls} max-w-64`}
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder={
                  info.rememberPassphrase
                    ? "Sync passphrase (saved — type to change)"
                    : "Sync passphrase"
                }
              />
              <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-400">
                <input
                  type="checkbox"
                  checked={info.rememberPassphrase}
                  onChange={(e) => void run(async () => {
                    await api.syncSaveSettings({
                      rememberPassphrase: e.target.checked,
                      passphrase: e.target.checked ? passphrase : "",
                    });
                    return undefined;
                  })}
                  className="h-4 w-4 accent-zinc-600"
                />
                Remember on this device
              </label>
              <span className="text-[11px] text-zinc-600">
                You'll need it again to pull on another device — don't lose it.
              </span>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button className="btn-primary" disabled={busy} onClick={() => void syncNow()}>
              {busy ? "Syncing…" : "Sync now"}
            </button>
            <button className="btn-ghost px-2 py-1 text-xs" disabled={busy} onClick={() => void checkCloud()}>
              Check cloud
            </button>
          </div>

          {cloud && (
            <div className="text-xs text-zinc-500">
              {cloud.exists
                ? `Cloud file exists${cloud.modified ? `, last modified ${cloud.modified.slice(0, 16).replace("T", " ")}` : ""}.`
                : "No cloud file yet."}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const inputCls = "input px-2 py-1 text-sm";
