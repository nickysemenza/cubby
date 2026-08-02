import type { CostType } from "@cubby/schemas/project";
import { costTypeValues } from "@cubby/schemas/project";
import { format, startOfYear, subDays, subMonths } from "date-fns";
import { match } from "ts-pattern";
import type { BadgeVariant } from "~/components/ui/badge";
import type { FilterableComboboxItem } from "~/components/ui/combobox";
import { buildSelectOptions } from "~/lib/select-options";
import { getCostTypeColor } from "~/lib/status-colors";

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

/**
 * `{value,label,color}` options for the cost-type filter/inline-edit select.
 * Not `buildSelectOptions` — that helper carries no color, and the swatch is
 * what makes the picklist read as the twin of the cell's chip.
 */
export const costTypeOptions: FilterableComboboxItem[] = costTypeValues.map(
  (value) => ({
    value,
    label: costTypeLabels[value],
    color: getCostTypeColor(value),
  }),
);

/** `{value,label}` options for the "future" (planned vs. made) filter. */
export const futureFilterOptions: FilterableComboboxItem[] = [
  { value: "true", label: "Planned" },
  { value: "false", label: "Already made" },
];

/** Fixed preset values for the expense-date-range filter. */
const dateRangeValues = ["30d", "90d", "ytd", "1y"] as const;
type DateRangePreset = (typeof dateRangeValues)[number];

/** Human labels for the date-range preset enum. */
const dateRangeLabels: Record<DateRangePreset, string> = {
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  ytd: "Year to date",
  "1y": "Last 12 months",
};

/** `{value,label}` options for the expense-date-range filter select. */
export const dateRangeOptions = buildSelectOptions(
  dateRangeValues,
  dateRangeLabels,
);

/**
 * Fixed preset values for the Cost column filter — the amount half. The two
 * presence sentinels (`has` / `none`) share the same control and the same
 * resolver; see `resolveCostFilter`.
 *
 * These four buckets are the windows the hand-written SQL kept rebuilding: the
 * big-ticket worklists, and credits. `credits` is `costMax: 0` rather than a
 * strict negative because a $0 row (a broken or gifted item, recorded at zero
 * rather than null) belongs in the same "no money went out" bucket.
 */
const costRangeValues = ["gte500", "gte200", "gte100", "credits"] as const;
type CostRangePreset = (typeof costRangeValues)[number];

/** Human labels for the cost-bucket preset enum. */
const costRangeLabels: Record<CostRangePreset, string> = {
  gte500: "$500 and up",
  gte200: "$200 and up",
  gte100: "$100 and up",
  credits: "Credits (≤ $0)",
};

/** `{value,label}` options for the amount half of the Cost column filter. */
export const costRangeOptions = buildSelectOptions(
  costRangeValues,
  costRangeLabels,
);

/**
 * Resolves the Cost column's selected value into the server fields it owns.
 *
 * One control covers both "is there a number at all" and "how big is it",
 * because a bucket already implies a recorded cost (`costMin: 100` can only
 * match a non-null row) — so the only combination the merge gives up is a
 * redundant one, and the column has exactly one filter slot.
 *
 * `has` / `none` are handled first and unchanged, so existing `?cost=has`
 * bookmarks keep resolving to `costPresenceFilter` exactly as before.
 *
 * Presets rather than a two-number input because the control layer has no
 * numeric-range widget. MCP and the URL still take exact `costMin`/`costMax`
 * (declared `urlOnly` in the manifest).
 */
export function resolveCostFilter(preset: string | undefined): {
  costPresenceFilter?: "has" | "none";
  costMin?: number;
  costMax?: number;
} {
  return (
    match(preset)
      .with("has", () => ({ costPresenceFilter: "has" as const }))
      .with("none", () => ({ costPresenceFilter: "none" as const }))
      .with("gte500", () => ({ costMin: 500 }))
      .with("gte200", () => ({ costMin: 200 }))
      .with("gte100", () => ({ costMin: 100 }))
      // Credits are real in this ledger (refunds, the family wedding
      // contributions) — never assume a lower bound of zero.
      .with("credits", () => ({ costMax: 0 }))
      .otherwise(() => ({}))
  );
}

/** Fixed preset values for the Quantity column's receipt-unit filter. */
const productQuantityRangeValues = ["exactly1", "gte2", "gte5"] as const;
type ProductQuantityRangePreset = (typeof productQuantityRangeValues)[number];

const productQuantityRangeLabels: Record<ProductQuantityRangePreset, string> = {
  exactly1: "Exactly 1",
  gte2: "2+ units",
  gte5: "5+ units",
};

export const productQuantityRangeOptions = buildSelectOptions(
  productQuantityRangeValues,
  productQuantityRangeLabels,
);

/** Resolve the Quantity header's presence and useful whole-unit buckets. */
export function resolveProductQuantityFilter(preset: string | undefined): {
  productQuantityPresenceFilter?: "has" | "none";
  productQuantityMin?: number;
  productQuantityMax?: number;
} {
  return match(preset)
    .with("has", () => ({ productQuantityPresenceFilter: "has" as const }))
    .with("none", () => ({ productQuantityPresenceFilter: "none" as const }))
    .with("exactly1", () => ({ productQuantityMin: 1, productQuantityMax: 1 }))
    .with("gte2", () => ({ productQuantityMin: 2 }))
    .with("gte5", () => ({ productQuantityMin: 5 }))
    .otherwise(() => ({}));
}

/**
 * Resolves a date-range preset (as read off the "date" column filter) into
 * inclusive "YYYY-MM-DD" bounds anchored on today's local date. An
 * unknown/undefined preset resolves to `{}` — no bound, matching every date
 * (see `plainDate` in `@cubby/schemas/project`; expense `date` is
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
