import { useState } from "react";
import { formatSalary } from "../lib/salary";
import { STATUSES, type Application } from "../types";

interface Props {
  applications: Application[];
  compactPay: boolean;
  onOpen: (app: Application) => void;
  /** Moves a card to another status column (backend logs the status change). */
  onMove: (app: Application, toStatus: string) => void;
}

/** Grip dots shown on every card's left edge; the draggable element. */
function Grip() {
  return (
    <svg width="8" height="14" viewBox="0 0 10 16" fill="currentColor" aria-hidden>
      <circle cx="2.5" cy="3" r="1.3" />
      <circle cx="7.5" cy="3" r="1.3" />
      <circle cx="2.5" cy="8" r="1.3" />
      <circle cx="7.5" cy="8" r="1.3" />
      <circle cx="2.5" cy="13" r="1.3" />
      <circle cx="7.5" cy="13" r="1.3" />
    </svg>
  );
}

export default function KanbanBoard({ applications, compactPay, onOpen, onMove }: Props) {
  const [dragId, setDragId] = useState<number | null>(null);
  const [overStatus, setOverStatus] = useState<string | null>(null);

  function endDrag() {
    setDragId(null);
    setOverStatus(null);
  }

  return (
    <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto pb-2">
      {STATUSES.map((status) => {
        const cards = applications.filter((a) => a.status === status.value);
        const isTarget =
          dragId !== null && overStatus === status.value;
        return (
          <div
            key={status.value}
            onDragOver={(e) => {
              e.preventDefault();
              setOverStatus(status.value);
            }}
            onDrop={(e) => {
              e.preventDefault();
              const dragged = applications.find((a) => a.id === dragId);
              if (dragged) onMove(dragged, status.value);
              endDrag();
            }}
            className={`flex min-w-56 max-w-64 flex-1 flex-col rounded-lg border bg-zinc-900/40 ${
              isTarget ? "border-sky-600 bg-sky-950/20" : "border-zinc-800"
            }`}
          >
            <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
              <span className={`h-2 w-2 rounded-full ${status.dot}`} />
              <span className="text-sm font-medium text-zinc-300">{status.label}</span>
              <span className="ml-auto rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-zinc-500">
                {cards.length}
              </span>
            </div>

            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
              {cards.map((app) => {
                const overdue =
                  app.nextFollowupAt && app.nextFollowupAt <= todayLocal();
                return (
                  <button
                    key={app.id}
                    className={`flex w-full cursor-pointer items-start gap-1.5 rounded-md border bg-zinc-900 p-2 text-left transition-colors hover:border-zinc-600 ${
                      app.id === dragId ? "opacity-40" : "border-zinc-800"
                    }`}
                    onClick={() => onOpen(app)}
                  >
                    <span
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", String(app.id));
                        setDragId(app.id);
                      }}
                      onDragEnd={endDrag}
                      className="mt-0.5 cursor-grab select-none text-zinc-600 hover:text-zinc-400 active:cursor-grabbing"
                      title="Drag to another column"
                    >
                      <Grip />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-zinc-100">
                        {app.company}
                      </span>
                      <span className="block truncate text-xs text-zinc-400">{app.role}</span>
                      <span className="mt-1.5 flex items-center gap-2">
                        <span className="text-xs text-zinc-500">
                          {formatSalary(app, { compact: compactPay })}
                        </span>
                        {overdue && (
                          <span
                            className="rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-300"
                            title="Follow-up date reached"
                          >
                            Follow up
                          </span>
                        )}
                      </span>
                    </span>
                  </button>
                );
              })}
              {cards.length === 0 && (
                <div className="rounded-md border border-dashed border-zinc-800 px-2 py-4 text-center text-xs text-zinc-700">
                  {dragId !== null ? "Drop here" : "Nothing here"}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
