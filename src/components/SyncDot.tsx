import { useEffect, useState } from "react";
import * as api from "../lib/api";
import type { SyncInfo } from "../lib/api";

/** Header pill showing cloud-sync state at a glance. Click → Settings. */
export default function SyncDot({
  refreshKey,
  onOpenSettings,
}: {
  refreshKey: number;
  onOpenSettings: () => void;
}) {
  const [info, setInfo] = useState<SyncInfo | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .syncGetInfo()
      .then((i) => {
        if (alive) setInfo(i);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [refreshKey]);

  let dot = "bg-zinc-600";
  let label = "Sync off";
  let title = "Cloud sync not connected — enable it in Settings.";
  if (info?.connected) {
    if (info.dirty) {
      dot = "bg-amber-400";
      label = "Not pushed";
      title = "You have changes that are not in Dropbox yet.";
    } else {
      dot = "bg-emerald-400";
      label = "Synced";
      title = info.lastSyncAt
        ? `Everything is in Dropbox (last sync ${info.lastSyncAt.slice(0, 16).replace("T", " ")}).`
        : "Everything is in Dropbox.";
    }
  }

  return (
    <button
      className="flex items-center gap-1.5 rounded-full border border-zinc-800 px-2.5 py-1 text-xs text-zinc-500 transition-colors hover:border-zinc-600 hover:text-zinc-300"
      onClick={onOpenSettings}
      title={title}
    >
      <span className={`h-2 w-2 rounded-full ${dot}`} />
      {label}
    </button>
  );
}
