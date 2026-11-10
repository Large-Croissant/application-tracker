/** Local `YYYY-MM-DD` for "today". */
export function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Splits a stored `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM` value into
 * (date, time) parts, with time empty for date-only entries.
 */
export function splitDateTime(value: string): { date: string; time: string } {
  const [date, time = ""] = value.split("T");
  return { date, time: time.slice(0, 5) };
}

/**
 * Combines a date and optional `HH:MM` time into one stored value.
 * Returns empty string when the date is empty.
 */
export function joinDateTime(date: string, time: string): string {
  if (!date) return "";
  return time ? `${date}T${time}` : date;
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** Formats a stored date or datetime for display, e.g.
 * "Nov 12, 2026" or "Nov 12, 2026 · 2:30 PM". */
export function formatWhen(value: string): string {
  const { date, time } = splitDateTime(value);
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return value;
  const day = `${MONTHS[m - 1]} ${d}, ${y}`;
  if (!time) return day;
  const [h, min] = time.split(":").map(Number);
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  const ampm = h < 12 ? "AM" : "PM";
  return `${day} · ${hour12}:${String(min).padStart(2, "0")} ${ampm}`;
}

/**
 * True when the entry is still in the future — i.e. planned rather than logged.
 * Date-only entries count as planned through the end of that day.
 */
export function isPlanned(occurredAt: string): boolean {
  const now = new Date();
  const { date, time } = splitDateTime(occurredAt);
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return false;
  if (time) {
    const [hh, mm] = time.split(":").map(Number);
    const at = new Date(y, m - 1, d, hh, mm);
    return at.getTime() > now.getTime();
  }
  const endOfDay = new Date(y, m - 1, d, 23, 59, 59);
  return endOfDay.getTime() > now.getTime();
}
