/** Local `YYYY-MM-DD` for "today". */
export function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// ---------- 12/24-hour display preference ----------

export type TimeFormat = "12" | "24";

const TIME_FORMAT_KEY = "jobtracker:timeFormat";
let timeFormat: TimeFormat =
  localStorage.getItem(TIME_FORMAT_KEY) === "24" ? "24" : "12";
const timeFormatListeners = new Set<() => void>();

/** Sets the display preference, persists it, and re-renders subscribers. */
export function setTimeFormat(f: TimeFormat): void {
  if (f === timeFormat) return;
  timeFormat = f;
  localStorage.setItem(TIME_FORMAT_KEY, f);
  timeFormatListeners.forEach((l) => l());
}

/**
 * Subscribes the calling component to the display preference, so toggling
 * it in Settings re-renders every view that shows times.
 */
export function useTimeFormat(): TimeFormat {
  return useSyncExternalStore(
    (l) => {
      timeFormatListeners.add(l);
      return () => timeFormatListeners.delete(l);
    },
    () => timeFormat,
    () => "12" as TimeFormat,
  );
}

/** Formats a stored `HH:MM` time according to the display preference. */
export function formatTimeOfDay(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  if (timeFormat === "24") return `${pad2(h)}:${pad2(m)}`;
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${pad2(m)} ${h < 12 ? "AM" : "PM"}`;
}

import { useSyncExternalStore } from "react";

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

/** Formats a stored date or datetime for display. The time part follows
 * the 12/24-hour display preference (Settings → Display), e.g.
 * "Nov 12, 2026 · 2:30 PM" or "Nov 12, 2026 · 14:30". */
export function formatWhen(value: string): string {
  const { date, time } = splitDateTime(value);
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return value;
  const day = `${MONTHS[m - 1]} ${d}, ${y}`;
  if (!time) return day;
  return `${day} · ${formatTimeOfDay(time)}`;
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
