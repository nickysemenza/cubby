import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

import { formatInstant } from "~/lib/date-format";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export {
  formatCompactCount,
  formatCompactCurrency,
  formatCount,
  formatCurrency,
  formatPercent,
  formatSmallCurrency,
  roundTo,
} from "~/lib/number-format";

// timeZone: "UTC" is load-bearing. __BUILD_DATE__ is a UTC ISO string; without
// pinning the zone, the CF edge (UTC) and the client (local tz) format it in
// different zones and can land on different calendar days near a UTC midnight
// boundary — server renders e.g. "Jun 12", client "Jun 11" → React #418
// hydration text mismatch. Formatting both sides in UTC keeps the text stable.
// Centralized here so every render site shares the one correct formatter.
/** Format a UTC ISO build-date string as "Mon D" (e.g. "Jun 12"), zone-pinned. */
export function formatBuildDate(iso: string): string {
  return formatInstant(iso, "monthDay", "UTC");
}
