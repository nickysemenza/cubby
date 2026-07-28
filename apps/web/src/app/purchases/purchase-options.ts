import type { CostType, PurchaseFilters, Trade } from "@cubby/schemas/project";
import { costTypeValues } from "@cubby/schemas/project";
import { format, startOfYear, subDays, subMonths } from "date-fns";
import { match } from "ts-pattern";
import type { BadgeVariant } from "~/components/ui/badge";
import type { FilterableComboboxItem } from "~/components/ui/combobox";
import { presenceFilterOptions } from "~/entities/filters";
import { buildSelectOptions } from "~/lib/select-options";

/** Human labels for the fixed cost-type enum. */
export const costTypeLabels: Record<(typeof costTypeValues)[number], string> = {
  materials: "Materials",
  tools: "Tools",
  services: "Services",
};

/**
 * Badge tone per cost-type — the chip twin of `COST_TYPE_COLORS`
 * (~/lib/status-colors), which encodes the same three buckets as chart fills.
 * The chart ramp is a monochrome ink ladder + ultramarine accent, so materials
 * (chart-1, ultramarine) → the ultramarine `default` chip, while tools
 * (chart-5, ink 40%) and services (chart-2, ink) → the two neutral chips
 * `slate` and `secondary` — lighter and darker to echo the ink ladder.
 */
export const costTypeBadgeVariant: Record<CostType, BadgeVariant> = {
  materials: "default",
  tools: "slate",
  services: "secondary",
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

/**
 * `{value,label}` options for the product-link presence filter ("has"/"none")
 * — a full product picklist isn't practical here (unlike `projectOptions`,
 * the product universe is unbounded), so the header filter only distinguishes
 * linked vs. unlinked rather than matching a specific product.
 */
export const productLinkedOptions = presenceFilterOptions("product");

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

/** The `/purchases` view modes. `ledger` is the unrestricted default. */
export type PurchaseViewMode =
  | "ledger"
  | "planned"
  | "unclassified"
  | "unassigned";

/**
 * Server-filter preset a view mode pins, fed to `useEntityList`'s
 * `extraFilters`.
 *
 * `extraFilters` spreads AFTER the manifest's column filters, so a preset here
 * always beats a live header-filter selection on the same key — which is the
 * intended precedence. `unassigned` pins `projectPresenceFilter: "none"`,
 * which is exactly the value the project column's nullable sentinel writes
 * for `?project=__none__` — so the preset is equivalent to a URL state a
 * saved view could reproduce, and needs no clobber of `projectId` alongside
 * it: the repo now ORs presence with any live project selection, so picking
 * a project on this tab *widens* it ("unassigned or Kitchen") instead of
 * emptying it.
 */
export function purchasePresetFilters(
  mode: PurchaseViewMode,
): Partial<PurchaseFilters> {
  return match(mode)
    .with("planned", () => ({ future: true }))
    .with("unclassified", () => ({ trade: "other" as Trade, costIsNull: true }))
    .with("unassigned", () => ({ projectPresenceFilter: "none" as const }))
    .with("ledger", () => ({}))
    .exhaustive();
}
