import { costTypeValues } from "@cubby/schemas/project";
import { format, startOfYear, subDays, subMonths } from "date-fns";
import { match } from "ts-pattern";
import type { FilterableComboboxItem } from "~/components/ui/combobox";
import { buildSelectOptions } from "~/lib/select-options";

/** Human labels for the fixed cost-type enum. */
export const costTypeLabels: Record<(typeof costTypeValues)[number], string> = {
  materials: "Materials",
  tools: "Tools",
  services: "Services",
};

/** `{value,label}` options for the cost-type filter/inline-edit select. */
export const costTypeOptions = buildSelectOptions(
  costTypeValues,
  costTypeLabels,
);

/** `{value,label}` options for the "future" (planned vs. made) filter. */
export const futureFilterOptions: FilterableComboboxItem[] = [
  { value: "true", label: "Planned" },
  { value: "false", label: "Already made" },
];

/** Fixed preset values for the purchase-date-range filter. */
const dateRangeValues = ["30d", "90d", "ytd", "1y"] as const;
type DateRangePreset = (typeof dateRangeValues)[number];

/** Human labels for the date-range preset enum. */
const dateRangeLabels: Record<DateRangePreset, string> = {
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  ytd: "Year to date",
  "1y": "Last 12 months",
};

/** `{value,label}` options for the purchase-date-range filter select. */
export const dateRangeOptions = buildSelectOptions(
  dateRangeValues,
  dateRangeLabels,
);

/**
 * Resolves a date-range preset (as read off the "date" column filter) into
 * inclusive "YYYY-MM-DD" bounds anchored on today's local date. An
 * unknown/undefined preset resolves to `{}` — no bound, matching every date
 * (see `plainDate` in `@cubby/schemas/project`; purchase `date` is
 * timezone-free, so bounds are computed from local `today`, never UTC).
 */
export function resolveDateRange(preset: string | undefined): {
  dateFrom?: string;
  dateTo?: string;
} {
  const today = new Date();
  const dateTo = format(today, "yyyy-MM-dd");
  const dateFrom = match(preset)
    .with("30d", () => format(subDays(today, 30), "yyyy-MM-dd"))
    .with("90d", () => format(subDays(today, 90), "yyyy-MM-dd"))
    .with("ytd", () => format(startOfYear(today), "yyyy-MM-dd"))
    .with("1y", () => format(subMonths(today, 12), "yyyy-MM-dd"))
    .otherwise(() => undefined);
  return dateFrom ? { dateFrom, dateTo } : {};
}
