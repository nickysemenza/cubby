import { match } from "ts-pattern";

/**
 * The filter manifest's pure core: the spec shape plus the builders that turn
 * column-filter state into a server filter object.
 *
 * Every list table used to declare its filters THREE times — a `filters:`
 * array on `useEntityList`, a per-column `filterConfig` in the column defs,
 * and a hand-written `buildFilters(tableState)` mapping column id → server
 * filter field. All nine `buildFilters` callbacks were the same mechanical
 * shape, which is what made a change like "multi-select on every table"
 * expensive. One manifest entry now drives all three.
 *
 * This module is deliberately dependency-free apart from ts-pattern: no React,
 * no `~/` imports. The vitest unit project can't resolve `~/…` .tsx, so
 * keeping the builders here is what makes them unit-testable. The registry
 * DATA lives in `filter-manifest.tsx`, which needs the icon-bearing option
 * lists.
 */

/**
 * How a column filter's string state maps onto a server filter field.
 *
 * `presence` is the shared "has"/"none" relation filter — deliberately NOT a
 * multiselect: the two values are complements, so selecting both would mean
 * "no filter", which is strictly worse than the single-select it replaces.
 */
export type FilterKind =
  | "text" // substring match
  | "select" // one enum value
  | "multiselect" // any-of a set of enum values
  | "presence" // "has" | "none"
  | "boolean" // "true" | "false"
  | "id" // one branded entity id
  | "idMulti" // any-of a set of branded entity ids
  | "range"; // preset key expanding to a {from,to} pair

/** The fields the pure builders need. See `FilterSpec` for the full shape. */
export interface FilterSpecCore {
  /** Table column this filter renders under. */
  columnId: string;
  /** Server filter key. Defaults to `columnId` when the two agree. */
  field?: string;
  kind: FilterKind;
  /** Brands a raw string into an entity id (`id` / `idMulti` only). */
  brand?: (value: string) => unknown;
  /** Expands a preset key into multiple server fields (`range` only). */
  expand?: (value: string) => Record<string, unknown>;
}

/** A column filter's state: TanStack stores whatever we set on it. */
export type FilterValue = string | string[] | undefined;

/** First value of a filter, whether it's stored as a scalar or an array. */
const single = (value: FilterValue): string | undefined =>
  Array.isArray(value) ? (value[0] ?? undefined) : value || undefined;

/**
 * All values of a filter, normalizing a scalar up into a single-element array.
 *
 * That normalization is load-bearing, not defensive: a scalar `"a"` and an
 * array `["a"]` are the same filter but produce DIFFERENT React Query keys.
 * Callers that derive filters through different paths (the ledger table and
 * the analytics view both build `PurchaseFilters`) would otherwise open two
 * cache entries holding identical results, and the UI flashes between them.
 * Everything funnels through here so one shape reaches the wire.
 */
const many = (value: FilterValue): string[] | undefined => {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values.length ? values : undefined;
};

/**
 * Column-filter state → the server's `*Filters` object.
 *
 * Returns only the keys that are actually filtered — an absent key means "no
 * constraint", which is what every `*FiltersSchema` expects. Empty arrays
 * collapse to absent for the same reason (and so `eqAny` can never be handed
 * a set that would degenerate into `IN ()`).
 */
export function buildFiltersFromManifest(
  specs: readonly FilterSpecCore[],
  get: (columnId: string) => FilterValue,
): Record<string, unknown> {
  const filters: Record<string, unknown> = {};

  for (const spec of specs) {
    const raw = get(spec.columnId);
    const field = spec.field ?? spec.columnId;

    const patch = match(spec.kind)
      .with("text", "select", "presence", () => {
        const value = single(raw);
        return value ? { [field]: value } : undefined;
      })
      .with("boolean", () => {
        const value = single(raw);
        return value === "true" || value === "false"
          ? { [field]: value === "true" }
          : undefined;
      })
      .with("id", () => {
        const value = single(raw);
        if (!value) return undefined;
        return { [field]: spec.brand ? spec.brand(value) : value };
      })
      .with("multiselect", () => {
        const values = many(raw);
        return values ? { [field]: values } : undefined;
      })
      .with("idMulti", () => {
        const values = many(raw);
        if (!values) return undefined;
        const brand = spec.brand;
        return { [field]: brand ? values.map(brand) : values };
      })
      .with("range", () =>
        // A range preset owns several server fields at once (dateFrom+dateTo),
        // so its expander returns the whole patch rather than one value.
        match(single(raw))
          .when(
            (value): value is string => value !== undefined,
            (value) => spec.expand?.(value),
          )
          .otherwise(() => undefined),
      )
      .exhaustive();

    if (patch) Object.assign(filters, patch);
  }

  return filters;
}

/** Kinds whose column-filter state is an array rather than a scalar. */
const MULTI_KINDS: ReadonlySet<FilterKind> = new Set<FilterKind>([
  "multiselect",
  "idMulti",
]);

export const isMultiFilterKind = (kind: FilterKind): boolean =>
  MULTI_KINDS.has(kind);
