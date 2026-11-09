import type { Application } from "../types";

/** Salary formatting/parsing. Amounts are plain numbers in the DB; display
 * formatting derives from the pay period, so each table row is human-readable. */

export const PAY_OPTIONS = [
  { value: "", label: "Not listed" },
  { value: "yearly", label: "Yearly salary" },
  { value: "monthly", label: "Monthly" },
  { value: "hourly", label: "Hourly" },
  { value: "contract", label: "Contract" },
  { value: "other", label: "Other" },
] as const;

/** Parses typed input into a plain number.
 * Accepts currency symbols, commas, spaces, and k/m abbreviations:
 * "$120,000" → 120000, "120k" → 120000, "1.2m" → 1200000, "" → null. */
export function parseAmount(text: string): number | null {
  const cleaned = text.replace(/[$,\s]/g, "");
  if (!cleaned) return null;
  const match = /^(\d+(?:\.\d+)?)([kKmM])?$/.exec(cleaned);
  if (!match) return null;
  let n = Number(match[1]);
  const suffix = match[2]?.toLowerCase();
  if (suffix === "k") n *= 1_000;
  else if (suffix === "m") n *= 1_000_000;
  return n;
}

/** Groups digits and at most 2 decimals while typing, so "120000" → "120,000". */
export function formatAmountInput(text: string): string {
  if (!text.trim()) return "";
  const n = parseAmount(text);
  if (n === null) return text; // unparseable input stays as typed
  const decimals = text.includes(".")
    ? Math.min((text.split(".")[1] ?? "").length, 2)
    : 0;
  return n.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Currency symbol via Intl, e.g. "$" for USD, "€" for EUR. */
function currencySymbol(currency: string): string {
  try {
    const parts = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
    }).formatToParts(0);
    return parts.find((p) => p.type === "currency")?.value ?? "";
  } catch {
    return "";
  }
}

/** Abbreviated amount for compact table display: "$125.5k", "$1.25m"; small
 * values render in full ("$32.50"). */
function abbrevAmount(n: number, currency: string): string {
  const abs = Math.abs(n);
  const symbol = currencySymbol(currency);
  if (abs >= 1_000) {
    const [divisor, suffix] = abs >= 1_000_000 ? [1_000_000, "m"] : [1_000, "k"];
    const value = n / divisor;
    // Up to 2 decimals, trailing zeros trimmed: 125.5k, 126k, 1.25m.
    const digits = value.toLocaleString("en-US", { maximumFractionDigits: 2 });
    return `${symbol}${digits}${suffix}`;
  }
  return `${symbol}${n.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
}

function fullAmount(n: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(n);
}

interface SalaryDisplayOptions {
  /** Compact ("$120k") instead of full ("$120,000"). */
  compact?: boolean;
}

/** Renders a stored salary for display, e.g. "$120,000" or "$32.50/hr". */
export function formatSalary(
  app: Pick<Application, "salaryAmount" | "salaryCurrency" | "salaryPeriod">,
  options: SalaryDisplayOptions = {},
): string {
  const { salaryAmount: amount, salaryCurrency: currency, salaryPeriod: period } = app;
  if (amount === null || amount === undefined) return "—";
  const cur = currency || "USD";
  const base = options.compact ? abbrevAmount(amount, cur) : fullAmount(amount, cur);
  switch (period) {
    case "monthly":
      return `${base}/mo`;
    case "hourly":
      return `${base}/hr`;
    case "contract":
      return `${base} (contract)`;
    default:
      return base;
  }
}
