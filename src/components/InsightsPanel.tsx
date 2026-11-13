import { useMemo } from "react";
import { STATUSES, type Application, type Status } from "../types";
import FlowChart from "./FlowChart";
import ErrorBoundary from "./ErrorBoundary";

interface Props {
  applications: Application[];
}

const INTERVIEWED_SET: Status[] = ["interviewing", "offer", "accepted"];
const RESPONDED_SET: Status[] = ["interviewing", "offer", "accepted", "rejected", "ghosted"];
const OFFER_SET: Status[] = ["offer", "accepted"];
const CLOSED_SET: Status[] = ["accepted", "rejected", "ghosted", "withdrawn"];

/** Cumulative "at least this far" sets for the funnel — current-stage
 * approximations, same basis as the stats strip. */
const FUNNEL: { label: string; hint: string; set: Status[]; color: string }[] = [
  {
    label: "Tracked",
    hint: "Every application in your list",
    set: STATUSES.map((s) => s.value as Status),
    color: "bg-zinc-500",
  },
  {
    label: "Applied",
    hint: "Anything past the wishlist",
    set: ["applied", "acknowledged", "interviewing", "offer", "accepted", "rejected", "ghosted", "withdrawn"],
    color: "bg-sky-400",
  },
  {
    label: "Acknowledged+",
    hint: "A company visibly reacted at some point",
    set: ["acknowledged", "interviewing", "offer", "accepted", "rejected", "ghosted"],
    color: "bg-cyan-400",
  },
  {
    label: "Interviewed",
    hint: "Reached the interview stage or beyond",
    set: INTERVIEWED_SET,
    color: "bg-amber-400",
  },
  {
    label: "Offered",
    hint: "An offer was on the table",
    set: OFFER_SET,
    color: "bg-emerald-400",
  },
];

/** One conversion number with its denominator/semantics. */
function ConversionTile({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div
      title={hint}
      className="min-w-28 flex-1 rounded-md border border-zinc-800 bg-zinc-900/50 px-3 py-2"
    >
      <div className="text-lg font-semibold text-zinc-100">{value}</div>
      <div className="text-[11px] text-zinc-500">{label}</div>
    </div>
  );
}

function Rate(n: number, d: number): string {
  return d > 0 ? `${Math.round((n / d) * 100)}%` : "—";
}

/** Full-page Insights: conversion numbers, funnel, stage mix, outcomes, volume. */
export default function InsightsPanel({ applications }: Props) {
  const count = (set: Status[]) =>
    applications.filter((a) => set.includes(a.status as Status)).length;

  const data = useMemo(() => {
    const apps = applications;
    const count = (set: Status[]) => apps.filter((a) => set.includes(a.status as Status)).length;

    const sent = apps.filter((a) => a.status !== "wishlist").length;
    const responded = count(RESPONDED_SET);
    const interviewed = count(INTERVIEWED_SET);
    const offered = count(OFFER_SET);
    const closedList = apps.filter((a) => CLOSED_SET.includes(a.status as Status));
    const closed = closedList.length;

    // Current-stage distribution across all nine statuses.
    const byStage = STATUSES.map((s) => ({
      ...s,
      n: apps.filter((a) => a.status === s.value).length,
    }));
    const stageMax = Math.max(1, ...byStage.map((s) => s.n));

    // Applications per month for the last 8 months (current month included).
    const now = new Date();
    const months: { label: string; n: number }[] = [];
    for (let i = 7; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const prefix = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const label = d.toLocaleString("en-US", { month: "short" });
      months.push({
        label,
        n: apps.filter((a) => (a.appliedAt ?? "").startsWith(prefix)).length,
      });
    }
    const monthMax = Math.max(1, ...months.map((m) => m.n));

    return {
      total: apps.length,
      sent,
      responded,
      interviewed,
      offered,
      closed,
      closedList,
      byStage,
      stageMax,
      months,
      monthMax,
    };
  }, [applications]);

  if (data.total === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-zinc-800 text-center">
        <div className="text-4xl">📊</div>
        <p className="max-w-sm text-sm text-zinc-500">
          Insights appear once you have applications to analyze.
        </p>
        <p className="max-w-sm text-xs text-zinc-600">
          Want to look around first? Sample data can be added from Settings → Developer.
        </p>
      </div>
    );
  }

  const REJECTION_NOTE =
    "Ghosted counts as a (negative) response; acknowledgements don't count — same rules as the stats strip.";

  return (
    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto pr-1">
      {/* Conversion numbers */}
      <section>
        <h3 className="mb-2 text-xs font-semibold text-zinc-500">Conversion</h3>
        <div className="flex flex-wrap gap-2">
          <ConversionTile label="Total tracked" value={String(data.total)} hint="Every application you have" />
          <ConversionTile label="Sent" value={String(data.sent)} hint="Everything past the wishlist" />
          <ConversionTile
            label="Response rate"
            value={Rate(data.responded, data.sent)}
            hint={`Of ${data.sent} sent, ${data.responded} produced interviews, offers, acceptances, rejections or ghostings. ${REJECTION_NOTE}`}
          />
          <ConversionTile
            label="Interview rate"
            value={Rate(data.interviewed, data.sent)}
            hint={`Of ${data.sent} sent, ${data.interviewed} reached the interview stage or beyond`}
          />
          <ConversionTile
            label="Offer rate"
            value={Rate(data.offered, data.interviewed)}
            hint={`Of the ${data.interviewed} that reached interviews, ${data.offered} produced an offer`}
          />
        </div>
      </section>

      {/* Flow (Sankey) of recorded movement through the pipeline */}
      <section>
        <h3 className="mb-2 text-xs font-semibold text-zinc-500">
          How applications flowed
          <span className="ml-2 font-normal text-zinc-600">
            rebuilt from recorded status history
          </span>
        </h3>
        <div className="max-w-3xl rounded-lg border border-zinc-800 bg-zinc-900/40 p-2">
          <ErrorBoundary>
            <FlowChart applications={applications} />
          </ErrorBoundary>
        </div>
      </section>

      {/* Funnel */}
      <section className="max-w-2xl">
        <h3 className="mb-2 text-xs font-semibold text-zinc-500">
          Pipeline funnel
          <span className="ml-2 font-normal text-zinc-600">by current stage</span>
        </h3>
        <ul className="space-y-1.5">
          {FUNNEL.map((stage, i) => {
            const n = count(stage.set);
            const width = Math.round((n / data.total) * 100);
            return (
              <li key={stage.label} className="flex items-center gap-3" title={stage.hint}>
                <span className="w-28 shrink-0 text-right text-xs text-zinc-500">
                  {stage.label}
                </span>
                <span className="min-w-0 flex-1 rounded-full bg-zinc-800/60">
                  <span
                    className={`block h-3.5 rounded-full ${stage.color}`}
                    style={{ width: `${width}%`, opacity: 1 - i * 0.12 }}
                  />
                </span>
                <span className="w-16 shrink-0 text-xs tabular-nums text-zinc-300">
                  {n}
                  {i > 0 && <span className="text-zinc-600"> · {width}%</span>}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      {/* Current stage distribution */}
      <section className="max-w-2xl">
        <h3 className="mb-2 text-xs font-semibold text-zinc-500">Where things stand</h3>
        <ul className="space-y-1">
          {data.byStage.map((stage) => (
            <li key={stage.value} className="flex items-center gap-3">
              <span className="w-28 shrink-0 text-right text-xs text-zinc-500">
                {stage.label}
              </span>
              <span className="min-w-0 flex-1">
                <span
                  className={`block h-2.5 rounded-full ${stage.dot}`}
                  style={{ width: `${Math.round((stage.n / data.stageMax) * 100)}%` }}
                />
              </span>
              <span className="w-10 shrink-0 text-xs tabular-nums text-zinc-300">
                {stage.n}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {/* Outcomes */}
      <section className="max-w-2xl">
        <h3 className="mb-2 text-xs font-semibold text-zinc-500">
          Outcomes of closed applications{" "}
          <span className="ml-1 font-normal text-zinc-600">{data.closed} closed</span>
        </h3>
        {data.closed === 0 ? (
          <p className="text-sm text-zinc-600">Nothing closed yet — you're live everywhere.</p>
        ) : (
          <div className="flex gap-2">
            {CLOSED_SET.map((status) => {
              const meta = STATUSES.find((s) => s.value === status);
              const n = data.closedList.filter((a) => a.status === status).length;
              return (
                <div
                  key={status}
                  className="flex-1 rounded-md border border-zinc-800 bg-zinc-900/50 px-3 py-2"
                >
                  <div className="flex items-center gap-1.5 text-sm font-semibold text-zinc-200">
                    <span className={`h-2 w-2 rounded-full ${meta?.dot ?? "bg-zinc-500"}`} />
                    {n}
                  </div>
                  <div className="text-[11px] text-zinc-500">
                    {meta?.label ?? status} · {Rate(n, data.closed)}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Monthly volume */}
      <section className="max-w-2xl">
        <h3 className="mb-2 text-xs font-semibold text-zinc-500">
          Applications per month
          <span className="ml-2 font-normal text-zinc-600">last 8 months</span>
        </h3>
        <div className="flex h-36 items-end gap-2">
          {data.months.map((m) => (
            <div key={m.label} className="flex min-w-0 flex-1 flex-col items-center gap-1">
              <span className="text-xs tabular-nums text-zinc-400">{m.n > 0 ? m.n : ""}</span>
              <span className="flex w-full flex-1 items-end">
                <span
                  className={`w-full rounded-t-md bg-sky-400/70 ${m.n === 0 ? "bg-zinc-800" : ""}`}
                  style={{ height: `${Math.round((m.n / data.monthMax) * 100)}%`, minHeight: m.n > 0 ? 4 : 2 }}
                />
              </span>
              <span className="text-[10px] text-zinc-600">{m.label}</span>
            </div>
          ))}
        </div>
        <p className="mt-1 text-[11px] text-zinc-600">
          Counted by the application date field, not this month's status.
        </p>
      </section>
    </div>
  );
}
