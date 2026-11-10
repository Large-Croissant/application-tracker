import { useEffect, useState } from "react";
import { statusMeta } from "../types";

interface Props {
  /** Current selection, or null when "nothing chosen" (bump controls). */
  current: string | null;
  onPick: (status: string | null) => void;
  /** "pill" = the drawer-header control; "compact" = small bump triggers. */
  variant: "pill" | "compact";
  /** Offer "Don't change" as the first option (correspondence bumps). */
  allowNone?: boolean;
  disabled?: boolean;
  title?: string;
}

const OPEN_STATUSES = ["wishlist", "applied", "acknowledged", "interviewing", "offer"];
const CLOSED_STATUSES = ["accepted", "rejected", "ghosted", "withdrawn"];

function OptionRow({
  status,
  selected,
  onPick,
}: {
  status: string;
  selected: boolean;
  onPick: () => void;
}) {
  const meta = statusMeta(status);
  return (
    <button
      className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-zinc-200 transition-colors hover:bg-zinc-800"
      onClick={onPick}
    >
      <span className={`h-2 w-2 shrink-0 rounded-full ${meta.dot}`} />
      <span className="flex-1">{meta.label}</span>
      {selected && <span className="text-xs text-zinc-500">current</span>}
    </button>
  );
}

/**
 * Stage picker with deliberate two-step interaction: open the menu, click a
 * stage. A custom popover (unlike a native select) can't change on hover
 * scroll, and there's only ever ONE status indicator on screen.
 */
export default function StatusMenu({
  current,
  onPick,
  variant,
  allowNone = false,
  disabled = false,
  title = "Change stage",
}: Props) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  function pick(value: string | null) {
    setOpen(false);
    onPick(value);
  }

  const meta = current ? statusMeta(current) : null;
  const trigger =
    variant === "pill" ? (
      current ? (
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${meta?.badge}`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${meta?.dot}`} />
          {meta?.label}
          <span className="ml-1 text-[10px] text-current opacity-60">▼</span>
        </span>
      ) : (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-xs font-medium text-zinc-300">
          Stage ▾
        </span>
      )
    ) : (
      <span className="btn-ghost px-2 py-0.5 text-xs">
        {current ? (
          <span className="inline-flex items-center gap-1.5">
            <span className={`h-1.5 w-1.5 rounded-full ${meta?.dot}`} />
            {meta?.label}
            <span className="opacity-60">▾</span>
          </span>
        ) : (
          "→ Stage ▾"
        )}
      </span>
    );

  return (
    <span className="relative inline-flex">
      <button
        className={variant === "pill" ? "cursor-pointer" : "cursor-pointer"}
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={title}
      >
        {trigger}
      </button>

      {open && (
        <>
          {/* Whole-surface click-catcher closes the menu; saves accidental picks */}
          <button
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setOpen(false)}
            aria-label="Close stage menu"
            tabIndex={-1}
          />
          <span className="absolute left-0 top-full z-50 mt-1 block w-60 overflow-hidden rounded-md border border-zinc-700 bg-zinc-900 py-1 shadow-2xl">
            {allowNone && (
              <button
                className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-zinc-400 transition-colors hover:bg-zinc-800"
                onClick={() => pick(null)}
              >
                Don’t change
                {!current && <span className="ml-auto text-xs text-zinc-600">current</span>}
              </button>
            )}
            {variant === "compact" && <div className="my-1 h-px bg-zinc-800" />}
            {variant === "pill" && (
              <div className="px-3 pb-1 pt-1 text-[10px] font-semibold tracking-wide text-zinc-600 uppercase">
                Open stages
              </div>
            )}
            {OPEN_STATUSES.map((s) => (
              <OptionRow
                key={s}
                status={s}
                selected={current === s}
                onPick={() => pick(s)}
              />
            ))}
            <div className="px-3 pb-1 pt-2 text-[10px] font-semibold tracking-wide text-zinc-600 uppercase">
              Closed
            </div>
            {CLOSED_STATUSES.map((s) => (
              <OptionRow
                key={s}
                status={s}
                selected={current === s}
                onPick={() => pick(s)}
              />
            ))}
          </span>
        </>
      )}
    </span>
  );
}
