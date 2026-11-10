import { formatSalary } from "../lib/salary";
import { STATUSES, type Application } from "../types";

interface Props {
  applications: Application[];
  compactPay: boolean;
  onOpen: (app: Application) => void;
}

export default function KanbanBoard({ applications, compactPay, onOpen }: Props) {
  return (
    <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto pb-2">
      {STATUSES.map((status) => {
        const cards = applications.filter((a) => a.status === status.value);
        return (
          <div
            key={status.value}
            className="flex min-w-56 max-w-64 flex-1 flex-col rounded-lg border border-zinc-800 bg-zinc-900/40"
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
                    className="w-full cursor-pointer rounded-md border border-zinc-800 bg-zinc-900 p-2.5 text-left transition-colors hover:border-zinc-600"
                    onClick={() => onOpen(app)}
                  >
                    <div className="truncate text-sm font-medium text-zinc-100">
                      {app.company}
                    </div>
                    <div className="truncate text-xs text-zinc-400">{app.role}</div>
                    <div className="mt-1.5 flex items-center gap-2">
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
                    </div>
                  </button>
                );
              })}
              {cards.length === 0 && (
                <div className="rounded-md border border-dashed border-zinc-800 px-2 py-4 text-center text-xs text-zinc-700">
                  Nothing here
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
