import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Format a number as USD currency.
 * @param value - The number to format
 * @param decimals - Maximum fraction digits (default: 2)
 */
export function formatCurrency(value: number, decimals = 2): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: decimals,
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
