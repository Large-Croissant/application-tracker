import { useMemo } from "react";
import type { Application, Status } from "../types";

interface Props {
  applications: Application[];
}

const ACTIVE_SET: Status[] = ["applied", "acknowledged", "interviewing", "offer"];
const INTERVIEWED_SET: Status[] = ["interviewing", "offer", "accepted"];
const RESPONDED_SET: Status[] = [
  "interviewing",
  "offer",
  "accepted",
  "rejected",
  "ghosted",
];

/** Numeric strip of headline stats across the whole application history.
 * Status-based approximations until timeline aggregates land in Insights. */
export default function StatsStrip({ applications }: Props) {
  const stats = useMemo(() => {
    const now = new Date();
    const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

    const total = applications.length;
    const active = applications.filter((a) => ACTIVE_SET.includes(a.status as Status)).length;
    const thisMonth = applications.filter((a) =>
      (a.appliedAt ?? "").startsWith(monthPrefix),
    ).length;
    const interviewStage = applications.filter(
      (a) => INTERVIEWED_SET.includes(a.status as Status),
    ).length;
    const offers = applications.filter(
      (a) => a.status === "offer" || a.status === "accepted",
    ).length;

    // Per project decision: only meaningful responses count — interviews, offers,
    // acceptances, rejections and ghostings. An acknowledgement is not a response.
    const sent = applications.filter((a) => a.status !== "wishlist").length;
    const responded = applications.filter((a) =>
      RESPONDED_SET.includes(a.status as Status),
    ).length;
    const responseRate = sent > 0 ? Math.round((responded / sent) * 100) : null;

    return [
      { label: "Total", value: total },
      { label: "Active", value: active },
      { label: "Applied this month", value: thisMonth },
      { label: "In interviews", value: interviewStage },
      { label: "Offers", value: offers },
      { label: "Response rate", value: responseRate === null ? "—" : `${responseRate}%` },
    ];
  }, [applications]);

  return (
    <div className="flex items-center gap-2">
      {stats.map(({ label, value }) => (
        <div
          key={label}
          title={
            label === "Response rate"
              ? "Counts interviews, offers, acceptances, rejections and ghostings — acknowledgements don't count as responses"
              : undefined
          }
          className="min-w-24 rounded-md border border-zinc-800 bg-zinc-900/50 px-3 py-1.5"
        >
          <div className="text-base font-semibold text-zinc-100">{value}</div>
          <div className="text-[11px] text-zinc-500">{label}</div>
        </div>
      ))}
    </div>
  );
}
