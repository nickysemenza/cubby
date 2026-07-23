import { unsafeProjectId } from "@cubby/schemas/identifiers";
import type { CostType, PurchaseFilters, Trade } from "@cubby/schemas/project";
import { costTypeValues } from "@cubby/schemas/project";
import { format, startOfYear, subDays, subMonths } from "date-fns";
import { match } from "ts-pattern";
import type { BadgeVariant } from "~/components/ui/badge";
import type { FilterableComboboxItem } from "~/components/ui/combobox";
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

/**
 * Column-filter state → tRPC `PurchaseFilters`. Shared by the ledger table's
 * `useEntityList` query, the ledger's compact totals row, and (via
 * {@link purchaseFiltersFromSearch}) the analytics view — so "filtered" can
 * never mean something different across the two `/purchases` views.
 */
export function buildPurchaseFilters(
  get: (columnId: string) => string | undefined,
): PurchaseFilters {
  const projectFilter = get("project");
  const futureFilter = get("future");
  return {
    search: get("name"),
    costType: (get("costType") as CostType | undefined) || undefined,
    trade: (get("trade") as Trade | undefined) || undefined,
    projectId: projectFilter ? unsafeProjectId(projectFilter) : undefined,
    future:
      futureFilter === undefined || futureFilter === ""
        ? undefined
        : futureFilter === "true",
    ...resolveDateRange(get("date")),
  };
}

/**
 * The subset of the `/purchases` route's search params that double as ledger
 * column-filter values (see the route file's search schema doc comment) —
 * `trade`/`costType`/`project`/`future`/`date` are stored URL-side with the
 * SAME string shape the table's column filters use, so this and
 * {@link buildPurchaseFilters} never need two different value encodings.
 */
export interface PurchaseSearchFilters {
  q?: string;
  trade?: string;
  costType?: string;
  project?: string;
  future?: string;
  date?: string;
}

/**
 * `purchaseFiltersFromSearch` — the URL-backed twin of `buildPurchaseFilters`
 * (table-state-backed). Used to seed the ledger table's initial filters and
 * to drive the analytics view's `purchase.analytics` call, so both derive
 * from the identical `PurchaseFilters` shape.
 */
export function purchaseFiltersFromSearch(
  search: PurchaseSearchFilters,
): PurchaseFilters {
  const map: Record<string, string | undefined> = {
    name: search.q,
    trade: search.trade,
    costType: search.costType,
    project: search.project,
    future: search.future,
    date: search.date,
  };
  return buildPurchaseFilters((id) => map[id]);
}
