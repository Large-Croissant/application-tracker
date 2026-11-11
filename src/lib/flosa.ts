/**
 * Flosa import: parses the JSON captured from my.flosa.app (the { list,
 * details } bundle produced by the collection script) and maps it onto
 * JobTracker's model:
 *
 *   list item (jobTitle, jobSalary, jobCompanyName, status 0..6, jobUrl,
 *   parsedLocationStr, date)  →  Application row
 *   detail page milestones ("Application Acknowledgement", "Interview",
 *   "Rejected", "Ghosted", …)  →  timeline events, including the
 *   status_change entries with "old → new" notes that drive the flow chart.
 *
 * Flosa's status enum (from its own JS):
 *   0 No Update · 1 Offer · 2 Rejected · 3 Offer Accepted · 4 Offer Rejected
 *   5 Ghosted · 6 On Going
 */

import type { ApplicationInput, EventKind } from "../types";

/**
 * The one-shot collection script for Flosa users: paste it into the browser
 * console on my.flosa.app (logged in) and it pages through every application,
 * fetches each application's page (its milestone history is embedded), and
 * downloads `flosa_full.json` — the exact shape parseFlosaFile expects.
 * Kept next to the parser so the two stay in sync.
 */
export const FLOSA_SCRIPT = `(async () => {
  const save = (name, text) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    a.download = name;
    a.click();
  };
  const post = (body) =>
    fetch("/api/v1/applications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.json());
  const collect = async (extra = {}) => {
    const out = [];
    for (let page = 0; page < 20; page++) {
      const res = await post({ page, pageSize: 50, ...extra });
      const arr = Array.isArray(res) ? res : (res?.data ?? []);
      if (!arr.length) break;
      out.push(...arr);
      if (arr.length < 50) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    return out;
  };
  const active = await collect();
  console.log("active:", active.length);
  const archived = await collect({ archived: true });
  console.log("archived:", archived.length);
  const seen = new Set();
  const list = [...active, ...archived].filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true)));
  console.log("TOTAL:", list.length);
  const details = [];
  for (let i = 0; i < list.length; i++) {
    details.push({ id: list[i].id, html: await fetch("/applications/" + list[i].id).then((r) => r.text()).catch(() => "") });
    if (i % 10 === 0) console.log("details", i + 1, "/", list.length);
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log("done:", details.filter((d) => d.html).length, "of", list.length);
  save("flosa_full.json", JSON.stringify({ list, details }));
  console.log("Downloaded flosa_full.json — check your Downloads folder.");
})();`;

export interface FlosaUpdate {
  name: string;
  datetime: number;
  notes?: string;
  cancelled?: boolean;
}

export interface FlosaApp {
  id: string;
  jobTitle: string;
  jobSalary: string | null;
  jobCompanyName: string;
  status: number;
  jobUrl: string | null;
  parsedLocationStr: string | null;
  date: number;
  tags?: unknown[];
}

export interface FlosaDetail {
  id: string;
  html?: string;
  /** already-extracted updates (our normalized dump) */
  updates?: FlosaUpdate[];
}

export interface FlosaFile {
  list: FlosaApp[];
  details?: FlosaDetail[];
}

export interface ParsedEvent {
  occurredAt: string;
  kind: EventKind;
  note: string;
}

export interface ParsedImport {
  input: ApplicationInput;
  /** Prebuilt timeline entries (status trail + milestone events). */
  events: ParsedEvent[];
  /** Extra info shown in the preview, not stored. */
  milestones: number;
}

export interface ParseStats {
  total: number;
  byStatus: Record<string, number>;
  events: number;
  issues: string[];
}

// ---------- Next.js flight extraction (detail pages embed milestones) ----------

function scanFlight(html: string): string {
  const MARK = 'self.__next_f.push([1,';
  let flight = "";
  let pos = 0;
  for (;;) {
    const i = html.indexOf(MARK, pos);
    if (i === -1) break;
    let q = i + MARK.length;
    while (html[q] === " ") q++;
    if (html[q] !== '"') {
      pos = i + MARK.length;
      continue;
    }
    let j = q + 1;
    let escaped = false;
    while (j < html.length) {
      const c = html[j];
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') break;
      j++;
    }
    try {
      flight += JSON.parse(html.slice(q, j + 1));
    } catch {
      // skip malformed push
    }
    pos = j + 1;
  }
  return flight;
}

/** Extracts the balanced-bracket JSON value starting at `start`. */
function extractBracket(flight: string, start: number): unknown {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < flight.length; i++) {
    const c = flight[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return JSON.parse(flight.slice(start, i + 1));
    }
  }
  return null;
}

function updatesFromDetail(detail: FlosaDetail): FlosaUpdate[] {
  if (Array.isArray(detail.updates)) return detail.updates;
  if (!detail.html) return [];
  const flight = scanFlight(detail.html);
  const i = flight.indexOf("initialUpdates");
  if (i === -1) return [];
  const bracket = flight.indexOf("[", i);
  if (bracket === -1) return [];
  const arr = extractBracket(flight, bracket);
  return Array.isArray(arr) ? (arr as FlosaUpdate[]) : [];
}

/** Pulls the application object embedded in the detail flight (its `notes`
 * field holds the content the user pasted into Flosa). */
export function applicationFromDetail(detail: FlosaDetail): { notes?: string } {
  if (!detail.html) return {};
  const flight = scanFlight(detail.html);
  const i = flight.indexOf("initialApplication");
  if (i === -1) return {};
  const brace = flight.indexOf("{", i);
  if (brace === -1) return {};
  const obj = extractBracket(flight, brace) as { notes?: string } | null;
  return obj && typeof obj.notes === "string" ? { notes: obj.notes } : {};
}

/** Very small HTML → text converter for pasted editor content. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------- salary ----------

export function parseSalary(
  raw: string | null | undefined,
): { amount: number | null; max: number | null; period: string } {
  if (!raw || !raw.trim()) return { amount: null, max: null, period: "" };
  const s = raw.replace(/[–—]/g, "-").replace(/\s+/g, " ").toLowerCase();
  const period = /per hour|per hr|\/hr|hourly|\/h\b/.test(s)
    ? "hourly"
    : /per year|per yr|\/yr|annum|annual|per annum/.test(s)
      ? "yearly"
      : "";
  const number = (part: string): number | null => {
    const m = part.replace(/[$,\s]/g, "").match(/^(\d+(?:\.\d+)?)([km])?/i);
    if (!m) return null;
    let v = parseFloat(m[1]);
    if (m[2]?.toLowerCase() === "k") v *= 1000;
    else if (m[2]?.toLowerCase() === "m") v *= 1_000_000;
    return v;
  };
  const parts = s.split("-");
  const amount = number(parts[0]);
  let max = parts.length > 1 ? number(parts[1]) : null;
  // "$26.44 - $33.66" with no stated period is hourly by inspection.
  const impliedHourly = !period && amount !== null && amount < 200 && (max ?? 0) < 200;
  return {
    amount,
    max,
    period: period || (impliedHourly ? "hourly" : ""),
  };
}

// ---------- dates ----------

function epochToIso(ms: number | undefined): string | null {
  if (!ms) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

/** `YYYY-MM-DDTHH:MM` in local time — Flosa milestones carry real times. */
function epochToIsoTime(ms: number | undefined): string | null {
  if (!ms) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const date = epochToIso(ms) ?? "";
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `${date}T${time}`;
}

// ---------- status mapping ----------

const INTERVIEW_RE = /interview|prescreen/i;

/** Maps Flosa's status int + milestone names onto our status vocabulary. */
export function mapStatus(
  flosaStatus: number,
  updates: FlosaUpdate[],
): { status: string; why: string } {
  const live = updates.filter((u) => !u.cancelled);
  const hasAck = live.some((u) => /acknowledg/i.test(u.name));
  const hasInterview = live.some((u) => INTERVIEW_RE.test(u.name));
  switch (flosaStatus) {
    case 0:
      return { status: "applied", why: "No Update → sent, no response" };
    case 1:
      return { status: "offer", why: "Offer" };
    case 2:
      return { status: "rejected", why: "Rejected" };
    case 3:
      return { status: "accepted", why: "Offer accepted" };
    case 4:
      return { status: "withdrawn", why: "Offer rejected (you declined) → withdrawn" };
    case 5:
      return { status: "ghosted", why: "Ghosted" };
    case 6:
      return hasInterview
        ? { status: "interviewing", why: "On Going + interview milestone" }
        : hasAck
          ? { status: "acknowledged", why: "On Going + acknowledgement" }
          : { status: "applied", why: "On Going with no milestones → applied" };
    default:
      return { status: "applied", why: `Unknown Flosa status ${flosaStatus}` };
  }
}

/** Composes an event note: milestone name, then the user's pasted content
 * (acknowledgement emails, interview notes, …) as readable text below it. */
function eventNote(u: FlosaUpdate): string {
  const body = u.notes ? htmlToText(String(u.notes)) : "";
  return body ? `${u.name}\n\n${body}` : u.name;
}

/** Turns one milestone into a timeline event (kind + note), no status change. */
function milestoneEvent(u: FlosaUpdate): ParsedEvent | null {
  const date = epochToIsoTime(u.datetime);
  if (!date) return null;
  if (/acknowledg/i.test(u.name)) {
    return { occurredAt: date, kind: "email", note: eventNote(u) };
  }
  if (/phone interview/i.test(u.name)) {
    return { occurredAt: date, kind: "call", note: eventNote(u) };
  }
  if (/prescreen/i.test(u.name)) {
    return { occurredAt: date, kind: "call", note: eventNote(u) };
  }
  if (/interview/i.test(u.name)) {
    return { occurredAt: date, kind: "interview", note: eventNote(u) };
  }
  if (/^rejected$/i.test(u.name)) {
    return { occurredAt: date, kind: "decision", note: eventNote(u) };
  }
  if (/offer/i.test(u.name)) {
    return { occurredAt: date, kind: "offer", note: eventNote(u) };
  }
  return { occurredAt: date, kind: "note", note: eventNote(u) };
}

const ARROW = " → ";

/**
 * Builds the status_change trail ("old → new" notes, strictly forward) that
 * the flow chart replays, plus the milestone events themselves.
 */
function buildEvents(
  updates: FlosaUpdate[],
  appliedAt: string | null,
  finalStatus: string,
): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  const live = updates
    .filter((u) => !u.cancelled)
    .sort((a, b) => a.datetime - b.datetime);

  if (appliedAt) {
    events.push({ occurredAt: appliedAt, kind: "note", note: "Applied (imported from Flosa)" });
  }

  let last = "applied";
  const change = (to: string, when: string) => {
    if (to === last) return;
    events.push({ occurredAt: when, kind: "status_change", note: `${last}${ARROW}${to}` });
    last = to;
  };

  // Every live milestone becomes a timeline event (with its pasted notes),
  // and the ones that mark a stage also drive the status trail. Chronological.
  for (const u of live) {
    const ev = milestoneEvent(u);
    if (ev) events.push(ev);
    const when = epochToIsoTime(u.datetime) ?? "";
    if (!when) continue;
    if (/acknowledg/i.test(u.name)) change("acknowledged", when);
    else if (INTERVIEW_RE.test(u.name)) change("interviewing", when);
    else if (/^rejected$/i.test(u.name)) change("rejected", when);
    else if (/^ghosted$/i.test(u.name)) change("ghosted", when);
  }

  // Terminal states without a milestone date (e.g. "No Update" + Rejected
  // status recorded later, or nothing recorded): anchor them on the applied
  // date so the app still reaches its current stage in the chart.
  if (last !== finalStatus) {
    const terminal = ["rejected", "ghosted", "withdrawn", "accepted", "offer"];
    if (terminal.includes(finalStatus)) {
      events.push({
        occurredAt: appliedAt ?? "",
        kind: "status_change",
        note: `${last}${ARROW}${finalStatus}`,
      });
    } else if (finalStatus === "acknowledged" || finalStatus === "interviewing") {
      events.push({
        occurredAt: appliedAt ?? "",
        kind: "status_change",
        note: `${last}${ARROW}${finalStatus}`,
      });
    }
  }
  return events;
}

// ---------- top-level parse ----------

export function parseFlosaFile(raw: FlosaFile): {
  items: ParsedImport[];
  stats: ParseStats;
} {
  const issues: string[] = [];
  const items: ParsedImport[] = [];
  const byStatus: Record<string, number> = {};
  let events = 0;

  const updatesFor = (app: FlosaApp): FlosaUpdate[] => {
    const d = raw.details?.find((x) => x.id === app.id);
    return d ? updatesFromDetail(d) : [];
  };

  for (const app of raw.list) {
    const company = (app.jobCompanyName ?? "").trim();
    const role = (app.jobTitle ?? "").trim();
    if (!company || !role) {
      issues.push(`Skipped a row without company/role (${company || "?"} / ${role || "?"}).`);
      continue;
    }
    const appliedAt = epochToIso(app.date);
    const updates = updatesFor(app);
    const { status, why } = mapStatus(app.status, updates);
    byStatus[status] = (byStatus[status] ?? 0) + 1;

    // The user's own notes from Flosa (pasted email contents etc.).
    const detail = raw.details?.find((x) => x.id === app.id);
    const ownNotes = detail ? htmlToText(applicationFromDetail(detail).notes ?? "") : "";

    const pay = parseSalary(app.jobSalary);
    const salaryNote = app.jobSalary?.trim()
      ? `\n\nSalary as listed in Flosa: "${app.jobSalary.trim()}"`
      : "";
    const importNote = ownNotes ? salaryNote : `Imported from Flosa (${why}).${salaryNote}`;
    const input: ApplicationInput = {
      company,
      role,
      status,
      source: "Flosa import",
      postingUrl: app.jobUrl ?? "",
      location: (app.parsedLocationStr ?? "").trim(),
      workMode: /remote/i.test(app.parsedLocationStr ?? "") ? "remote" : "",
      salaryAmount: pay.amount,
      salaryAmountMax: pay.max,
      salaryCurrency: "USD",
      salaryPeriod: pay.period,
      contactName: "",
      contactEmail: "",
      notes: [ownNotes, importNote.trim()].filter((s) => s).join("\n\n"),
      postingText: "",
      appliedAt,
      nextFollowupAt: null,
    };
    const built = buildEvents(updates, appliedAt, status);
    events += built.length;
    items.push({ input, events: built, milestones: updates.filter((u) => !u.cancelled).length });
  }
  return { items, stats: { total: items.length, byStatus, events, issues } };
}
