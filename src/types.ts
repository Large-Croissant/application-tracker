/** Shared domain types mirroring the Rust models (camelCase payloads). */

export type Status =
  | "wishlist"
  | "applied"
  | "acknowledged"
  | "interviewing"
  | "offer"
  | "accepted"
  | "rejected"
  | "ghosted"
  | "withdrawn";

export const UPDATEABLE_STATUSES: Status[] = [
  "wishlist",
  "applied",
  "acknowledged",
  "interviewing",
  "offer",
  "rejected",
  "ghosted",
  "withdrawn",
];

/** Terminal (inactive) statuses. */
export const TERMINAL_STATUSES: Status[] = ["accepted", "rejected", "ghosted", "withdrawn"];

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
    value: "acknowledged",
    label: "Acknowledged",
    badge: "bg-cyan-500/10 text-cyan-300 border-cyan-500/30",
    dot: "bg-cyan-400",
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
    value: "ghosted",
    label: "Ghosted",
    badge: "bg-slate-500/10 text-slate-400 border-slate-500/30",
    dot: "bg-slate-500",
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
  /** Optional upper bound of a pay range. */
  salaryAmountMax: number | null;
  salaryCurrency: string;
  salaryPeriod: string;
  contactName: string;
  contactEmail: string;
  notes: string;
  postingText: string;
  appliedAt: string | null;
  nextFollowupAt: string | null;
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
  /** Optional upper bound of a pay range. */
  salaryAmountMax: number | null;
  salaryCurrency: string;
  salaryPeriod: string;
  contactName: string;
  contactEmail: string;
  notes: string;
  postingText: string;
  appliedAt: string | null;
  nextFollowupAt: string | null;
}

/** Fixed timeline event kinds (mirrors the Rust validation list). */
export type EventKind =
  | "note"
  | "call"
  | "interview"
  | "offer"
  | "decision"
  | "status_change"
  | "email"
  | "meeting";

/** Display metadata for every timeline kind. Correspondence and status changes
 * are logged automatically; the manual composer only creates notes. */
export const EVENT_KINDS: readonly {
  value: EventKind;
  label: string;
  dot: string;
}[] = [
  { value: "note", label: "Note", dot: "bg-zinc-400" },
  { value: "call", label: "Call", dot: "bg-sky-400" },
  { value: "interview", label: "Interview", dot: "bg-amber-400" },
  { value: "offer", label: "Offer", dot: "bg-emerald-400" },
  { value: "decision", label: "Decision", dot: "bg-violet-400" },
  { value: "status_change", label: "Status change", dot: "bg-fuchsia-400" },
  { value: "email", label: "Email", dot: "bg-cyan-300" },
  { value: "meeting", label: "Meeting", dot: "bg-teal-400" },
] as const;

export function eventKindMeta(kind: string) {
  return (
    EVENT_KINDS.find((k) => k.value === kind) ?? {
      value: kind as EventKind,
      label: kind,
      dot: "bg-zinc-500",
    }
  );
}

export interface ApplicationEvent {
  id: number;
  applicationId: number;
  /** `YYYY-MM-DD`, or `YYYY-MM-DDTHH:MM` when a time is kept. */
  occurredAt: string;
  kind: EventKind | string;
  note: string;
  /** Set when this entry is the timeline record of a correspondence item. */
  correspondenceId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface EventInput {
  occurredAt: string | null;
  kind: EventKind | string;
  note: string;
}

export type CorrespondenceKind = "email" | "call" | "meeting";

export const CORRESPONDENCE_KINDS: readonly {
  value: CorrespondenceKind;
  label: string;
  dot: string;
}[] = [
  { value: "email", label: "Email", dot: "bg-cyan-300" },
  { value: "call", label: "Call", dot: "bg-sky-400" },
  { value: "meeting", label: "Meeting", dot: "bg-teal-400" },
] as const;

export function correspondenceKindMeta(kind: string) {
  return (
    CORRESPONDENCE_KINDS.find((k) => k.value === kind) ?? {
      value: kind as CorrespondenceKind,
      label: kind,
      dot: "bg-zinc-500",
    }
  );
}

export const MEETING_MODES: readonly { value: string; label: string }[] = [
  { value: "virtual", label: "Virtual" },
  { value: "in_person", label: "In person" },
] as const;

export interface ApplicationCorrespondence {
  id: number;
  applicationId: number;
  kind: CorrespondenceKind | string;
  /** `YYYY-MM-DD`, or `YYYY-MM-DDTHH:MM` when a time is kept. */
  occurredAt: string;
  /** Meetings only: virtual | in_person */
  meetingMode: string | null;
  /** Email body, call summary, or meeting notes. */
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface CorrespondenceInput {
  kind: CorrespondenceKind | string;
  occurredAt: string | null;
  meetingMode: string | null;
  body: string;
  /** Optional status bump applied together with saving. */
  followUpStatus: string | null;
}

// ---------- Vault ----------

export interface ProfileField {
  key: string;
  value: string;
  updatedAt: string;
}

export interface ReferenceContact {
  id: number;
  name: string;
  relationship: string;
  title: string;
  company: string;
  email: string;
  phone: string;
  linkedin: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReferenceInput {
  name: string;
  relationship: string;
  title: string;
  company: string;
  email: string;
  phone: string;
  linkedin: string;
  notes: string;
}

export interface PreparedAnswer {
  id: number;
  title: string;
  body: string;
  category: string;
  createdAt: string;
  updatedAt: string;
}

export interface AnswerInput {
  title: string;
  body: string;
  category: string;
}

export interface ResumeVersion {
  id: number;
  name: string;
  fileName: string;
  notes: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface ResumeInput {
  name: string;
  fileName: string;
  notes: string;
  content: string;
}
