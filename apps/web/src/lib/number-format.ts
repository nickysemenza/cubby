import { wasmFormat } from "~/lib/wasm";

// Pure number formatters, kept free of UI dependencies so chart theme modules
// can import them. `lib/utils` re-exports everything here.

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
 * Format a number as USD currency (en-US, half away from zero) through the
 * Rust formatter shared with native.
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
  const minimum = options.minimumFractionDigits ?? Math.min(2, decimals);
  return wasmFormat.format_currency(
    value,
    minimum,
    Math.max(decimals, minimum),
  );
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
export function formatCompactCount(
  value: number,
  maximumFractionDigits?: number,
): string {
  return cachedNumberFormat({
    notation: "compact",
    maximumFractionDigits,
  }).format(value);
}

/** `$1.23`, or `<$0.01` for a positive cost too small to show at cent precision. */
export function formatSmallCurrency(value: number): string {
  return value > 0 && value < 0.01 ? "<$0.01" : formatCurrency(value);
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
