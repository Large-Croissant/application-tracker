/** Shared domain types mirroring the Rust models (camelCase payloads). */

export type Status =
  | "wishlist"
  | "applied"
  | "interviewing"
  | "offer"
  | "accepted"
  | "rejected"
  | "withdrawn";

export const UPDATEABLE_STATUSES: Status[] = [
  "wishlist",
  "applied",
  "interviewing",
  "offer",
  "rejected",
  "withdrawn",
];

export const STATUSES: readonly {
  value: Status;
  label: string;
  badge: string;
  dot: string;
}[] = [
  {
    value: "wishlist",
    label: "Wishlist",
    badge: "bg-violet-500/10 text-violet-300 border-violet-500/30",
    dot: "bg-violet-400",
  },
  {
    value: "applied",
    label: "Applied",
    badge: "bg-sky-500/10 text-sky-300 border-sky-500/30",
    dot: "bg-sky-400",
  },
  {
    value: "interviewing",
    label: "Interviewing",
    badge: "bg-amber-500/10 text-amber-300 border-amber-500/30",
    dot: "bg-amber-400",
  },
  {
    value: "offer",
    label: "Offer",
    badge: "bg-emerald-500/10 text-emerald-300 border-emerald-500/30",
    dot: "bg-emerald-400",
  },
  {
    value: "accepted",
    label: "Accepted",
    badge: "bg-green-500/10 text-green-300 border-green-500/30",
    dot: "bg-green-400",
  },
  {
    value: "rejected",
    label: "Rejected",
    badge: "bg-red-500/10 text-red-300 border-red-500/30",
    dot: "bg-red-400",
  },
  {
    value: "withdrawn",
    label: "Withdrawn",
    badge: "bg-zinc-500/10 text-zinc-400 border-zinc-500/30",
    dot: "bg-zinc-500",
  },
] as const;

export function statusMeta(value: string) {
  return (
    STATUSES.find((s) => s.value === value) ?? {
      value: value as Status,
      label: value,
      badge: "bg-zinc-500/10 text-zinc-400 border-zinc-500/30",
      dot: "bg-zinc-500",
    }
  );
}

export interface Application {
  id: number;
  company: string;
  role: string;
  status: Status | string;
  source: string;
  postingUrl: string;
  location: string;
  workMode: string;
  salaryAmount: number | null;
  salaryCurrency: string;
  salaryPeriod: string;
  contactName: string;
  contactEmail: string;
  notes: string;
  appliedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApplicationInput {
  company: string;
  role: string;
  status: Status | string;
  source: string;
  postingUrl: string;
  location: string;
  workMode: string;
  salaryAmount: number | null;
  salaryCurrency: string;
  salaryPeriod: string;
  contactName: string;
  contactEmail: string;
  notes: string;
  appliedAt: string | null;
}
