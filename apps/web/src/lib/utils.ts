import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// `Intl.NumberFormat` is expensive to construct — one shared instance per
// distinct option set (record counts, usage tallies, token counts, currency,
// percent, compact notation) instead of a fresh formatter per render site.
// Keyed on exactly the options every formatter below varies: `style` and
// `notation` pick the family, `currency` only matters for `style: "currency"`,
// and the fraction-digit bounds tune precision within a family.
interface CachedNumberFormatOptions {
  style?: "decimal" | "currency" | "percent";
  currency?: string;
  minimumFractionDigits?: number;
  maximumFractionDigits?: number;
  notation?: "standard" | "compact";
  signDisplay?: "auto" | "exceptZero" | "always" | "never";
}

const numberFormatCache = new Map<string, Intl.NumberFormat>();

function cachedNumberFormat(
  options: CachedNumberFormatOptions,
): Intl.NumberFormat {
  const key = [
    options.style ?? "",
    options.currency ?? "",
    options.minimumFractionDigits ?? "",
    options.maximumFractionDigits ?? "",
    options.notation ?? "",
    options.signDisplay ?? "",
  ].join("|");
  let formatter = numberFormatCache.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat("en-US", options);
    numberFormatCache.set(key, formatter);
  }
  return formatter;
}

/**
 * Format a number as USD currency.
 * @param value - The number to format
 * @param decimals - Maximum fraction digits (default: 2)
 * @param options - `minimumFractionDigits`, for a precision that doesn't fit
 * a single "decimals" knob (e.g. sub-cent AI usage costs).
 */
export function formatCurrency(
  value: number,
  decimals = 2,
  options: { minimumFractionDigits?: number } = {},
): string {
  return cachedNumberFormat({
    style: "currency",
    currency: "USD",
    maximumFractionDigits: decimals,
    ...options,
  }).format(value);
}

/** Format currency in compact notation (e.g. "$1.2M"). */
export function formatCompactCurrency(value: number): string {
  return cachedNumberFormat({
    style: "currency",
    currency: "USD",
    notation: "compact",
  }).format(value);
}

/** Format a plain integer with thousands separators (e.g. "1,240"). */
export function formatCount(value: number, decimals = 0): string {
  return cachedNumberFormat({ maximumFractionDigits: decimals }).format(value);
}

/** Format a count in compact notation (e.g. "1.2K"). */
export function formatCompactCount(value: number): string {
  return cachedNumberFormat({ notation: "compact" }).format(value);
}

/**
 * Format a ratio (0.1234) as a percentage ("12.3%"). `signDisplay` defaults
 * to `"auto"`; pass `"exceptZero"` for a delta that should show `+`/`-`.
 */
export function formatPercent(
  value: number,
  options: {
    maximumFractionDigits?: number;
    signDisplay?: "auto" | "exceptZero";
  } = {},
): string {
  return cachedNumberFormat({
    style: "percent",
    maximumFractionDigits: options.maximumFractionDigits ?? 1,
    signDisplay: options.signDisplay ?? "auto",
  }).format(value);
}

// timeZone: "UTC" is load-bearing. __BUILD_DATE__ is a UTC ISO string; without
// pinning the zone, the CF edge (UTC) and the client (local tz) format it in
// different zones and can land on different calendar days near a UTC midnight
// boundary — server renders e.g. "Jun 12", client "Jun 11" → React #418
// hydration text mismatch. Formatting both sides in UTC keeps the text stable.
// Centralized here so every render site shares the one correct formatter.
const buildDateFormatter = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

/** Format a UTC ISO build-date string as "Mon D" (e.g. "Jun 12"), zone-pinned. */
export function formatBuildDate(iso: string): string {
  return buildDateFormatter.format(new Date(iso));
}
