import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { formatTimeOfDay, useTimeFormat } from "../lib/datetime";

/**
 * A time picker that replaces the native `<input type="time">`, whose
 * WebView2 scroll wheels wrap around forever. This one:
 *  - accepts typed entry ("9", "9:30", "930", "9:30 pm", "15:30", "3.30"),
 *  - opens a popover with hour / minute / AM-PM columns that scroll to
 *    absolute positions (item N is always at scroll offset N × row height),
 *    so fast scrolling lands exactly where you aim.
 * Value is `HH:MM` (24h) or "" for no time — same contract as before.
 */

const ROW_H = 26; // px per list item; keep in sync with the row class
const VISIBLE_ROWS = 7;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Flexible time text parser. Returns `HH:MM`, "" for empty input, or null
 * when the text isn't (yet) a complete valid time.
 * Accepts: 9 · 9:30 · 9.30 · 930 · 0930 · 9:30 pm · 9p · 15:30 · 1530 · 12
 * Bare 1–11 reads as AM; bare 12 reads as noon; 13–23 reads as 24-hour.
 */
export function parseTimeText(text: string): string | null {
  const t = text.trim().toLowerCase().replace(/[\s.]/g, "");
  if (!t) return "";
  let mer: "am" | "pm" | null = null;
  let body = t;
  const merMatch = /(am|pm)$/.exec(t);
  if (merMatch) {
    mer = merMatch[1] as "am" | "pm";
    body = t.slice(0, merMatch.index);
    if (!body) return null;
  }
  let h: number;
  let min = 0;
  let m: RegExpExecArray | null;
  if ((m = /^(\d{1,2}):(\d{1,2})$/.exec(body))) {
    h = +m[1];
    min = +m[2];
  } else if ((m = /^(\d{3,4})$/.exec(body))) {
    h = m[1].length === 3 ? +m[1][0] : +m[1].slice(0, 2);
    min = +m[1].slice(-2);
  } else if ((m = /^(\d{1,2})$/.exec(body))) {
    h = +m[1];
  } else {
    return null;
  }
  if (min > 59 || h > 23 || (mer && (h < 1 || h > 12))) return null;
  if (mer === "pm" && h !== 12) h += 12;
  else if (mer === "am" && h === 12) h = 0;
  // No meridiem typed: 13-23 stays 24h; bare 1-11 is AM; bare 12 is noon.
  return `${pad2(h)}:${pad2(min)}`;
}

/** Decomposes `HH:MM` into picker coordinates. */
function parts(hhmm: string): { h12: number; min: number; am: boolean } {
  const [h, m] = hhmm.split(":").map(Number);
  return { h12: h % 12 === 0 ? 12 : h % 12, min: m, am: h < 12 };
}

function compose(h12: number, min: number, am: boolean): string {
  const h = am ? (h12 === 12 ? 0 : h12) : h12 === 12 ? 12 : h12 + 12;
  return `${pad2(h)}:${pad2(min)}`;
}
/** A single scrolling column: absolute item positions, no wrap-around. */
function Column({
  items,
  selected,
  onPick,
  label,
}: {
  items: string[];
  selected: number | null;
  onPick: (index: number) => void;
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (selected != null && ref.current) {
      ref.current.scrollTop = Math.max(
        0,
        selected * ROW_H - ((VISIBLE_ROWS - 1) * ROW_H) / 2,
      );
    }
  }, [selected]);

  return (
    <div>
      <div className="px-1 pb-1 text-center text-[10px] uppercase tracking-wide text-zinc-500">
        {label}
      </div>
      <div
        ref={ref}
        className="snap-y snap-mandatory overflow-y-auto"
        style={{ height: VISIBLE_ROWS * ROW_H }}
        role="listbox"
        aria-label={label}
      >
        {items.map((item, i) => (
          <button
            key={item}
            type="button"
            role="option"
            aria-selected={selected === i}
            onClick={() => onPick(i)}
            className={`block w-full snap-start text-center text-xs tabular-nums ${
              selected === i
                ? "bg-zinc-700 font-medium text-white"
                : "text-zinc-300 hover:bg-zinc-800"
            }`}
            style={{ height: ROW_H, lineHeight: `${ROW_H}px` }}
          >
            {item}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function TimePicker({
  value,
  onChange,
  className = "",
  ariaLabel,
  title,
}: {
  value: string; // "HH:MM" or ""
  onChange: (time: string) => void;
  className?: string;
  ariaLabel?: string;
  title?: string;
}) {
  const [text, setText] = useState(() => (value ? formatTimeOfDay(value) : ""));
  const [open, setOpen] = useState(false);
  const [openUp, setOpenUp] = useState(false);
  const is24 = useTimeFormat() === "24";
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const focusedRef = useRef(false);

  // External value changes (e.g. form reset) refresh the text box unless the
  // user is mid-edit. Also follows the 12/24-hour display preference.
  useEffect(() => {
    if (!focusedRef.current) setText(value ? formatTimeOfDay(value) : "");
  }, [value, is24]);

  // Close when clicking anywhere outside, or when the drawer scrolls
  // (the popover is anchored, so it would drift with the content).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onScroll = () => setOpen(false);
    const scroller = wrapRef.current?.closest(".overflow-y-auto");
    scroller?.addEventListener("scroll", onScroll);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("mousedown", onDown);
      scroller?.removeEventListener("scroll", onScroll);
    };
  }, [open]);

  // Open the popover below the input, or above it when there isn't room.
  const openPicker = () => {
    const el = wrapRef.current;
    if (el) {
      const scroller = el.closest(".overflow-y-auto");
      if (scroller) {
        const er = el.getBoundingClientRect();
        const sr = scroller.getBoundingClientRect();
        const panelH = VISIBLE_ROWS * ROW_H + 60;
        setOpenUp(sr.bottom - er.bottom < panelH);
      }
    }
    setOpen(true);
  };

  const emit = (hhmm: string) => {
    if (hhmm !== value) onChange(hhmm);
  };

  const onType = (raw: string) => {
    setText(raw);
    const parsed = parseTimeText(raw);
    if (parsed !== null) emit(parsed);
  };

  const onBlurText = () => {
    focusedRef.current = false;
    const parsed = parseTimeText(text);
    if (parsed === null || parsed === "") {
      // Unparseable (or cleared) text falls back to the actual value.
      setText(value ? formatTimeOfDay(value) : "");
    } else {
      setText(formatTimeOfDay(parsed));
      emit(parsed);
    }
  };

  const cur = value ? parts(value) : null;
  const h12 = cur?.h12 ?? 9;
  const min = cur?.min ?? 0;
  const am = cur?.am ?? true;
  const h24 = value ? Number(value.slice(0, 2)) : 9;

  const pickHour = (i: number) => {
    const v = is24
      ? `${pad2(i)}:${pad2(min)}`
      : compose(i + 1, min, am);
    setText(formatTimeOfDay(v));
    emit(v);
  };
  const pickMinute = (i: number) => {
    const v = is24 ? `${pad2(h24)}:${pad2(i)}` : compose(h12, i, am);
    setText(formatTimeOfDay(v));
    emit(v);
  };
  const pickAmPm = (i: number) => {
    const v = compose(h12, min, i === 0);
    setText(formatTimeOfDay(v));
    emit(v);
  };
  const clear = () => {
    setText("");
    emit("");
    inputRef.current?.focus();
  };

  return (
    <div ref={wrapRef} className="relative">
      <input
        ref={inputRef}
        type="text"
        inputMode="numeric"
        className={`input ${className}`}
        value={text}
        placeholder="Time…"
        aria-label={ariaLabel}
        title={title ?? "Type a time (e.g. 9:30 PM) or scroll the picker"}
        onChange={(e) => onType(e.target.value)}
        onFocus={() => {
          focusedRef.current = true;
          openPicker();
        }}
        onBlur={onBlurText}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setText(value ? formatTimeOfDay(value) : "");
            setOpen(false);
            inputRef.current?.blur();
          }
          if (e.key === "Enter") {
            setOpen(false);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      {open && (
        <div
          className={`absolute z-30 flex gap-1 rounded-lg border border-zinc-700 bg-zinc-900 p-2 shadow-xl ${
            openUp ? "bottom-full mb-1" : "top-full mt-1"
          }`}
        >
          <Column
            label="Hour"
            items={
              is24
                ? Array.from({ length: 24 }, (_, i) => String(i))
                : Array.from({ length: 12 }, (_, i) => String(i + 1))
            }
            selected={value ? (is24 ? h24 : h12 - 1) : null}
            onPick={pickHour}
          />
          <Column
            label="Min"
            items={Array.from({ length: 60 }, (_, i) => pad2(i))}
            selected={value ? min : null}
            onPick={pickMinute}
          />
          {!is24 && (
            <Column
              label=""
              items={["AM", "PM"]}
              selected={value ? (am ? 0 : 1) : null}
              onPick={pickAmPm}
            />
          )}
          <div className="flex flex-col justify-end gap-1 pl-1">
            <button
              type="button"
              className="rounded px-1.5 py-1 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
              onClick={clear}
              title="No time"
            >
              Clear
            </button>
            <button
              type="button"
              className="rounded px-1.5 py-1 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
              onClick={() => setOpen(false)}
              title="Done"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
