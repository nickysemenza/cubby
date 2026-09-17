import type { FILTER_KINDS } from "@cubby/schemas/entity-definitions/definition";
import { humanize, UNRESOLVABLE_ENTITY_FILTER } from "@cubby/shared";
import { partition } from "es-toolkit";
import { match } from "ts-pattern";
import { z } from "zod";

/**
 * text: substring match. select: one enum value. multiselect: any-of a set of
 * enum values. presence: "has" | "none". boolean: "true" | "false". id: one
 * branded entity id. idMulti: any-of a set of branded entity ids. range:
 * preset key expanding to a {from,to} pair.
 */
export type FilterKind = (typeof FILTER_KINDS)[number];

/** Scalar values accepted by the server-side filter contracts. */
type FilterScalar = string | number | boolean;

/** Values written into a named server filter patch. */
type FilterOutputValue = FilterScalar | string[] | null | undefined;

/** The open field set shared by generated entity filter schemas. */
export type FilterPatch = Partial<Record<string, FilterOutputValue>>;

/** URL search values after the router's ingress parser has accepted them. */
export type FilterSearch = Readonly<Record<string, string | undefined>>;

const filterSearchValueSchema = z.string().optional();

/** Parse router search state into the string-valued filter representation. */
const parseFilterSearch = <TSearch extends {}>(input: TSearch) => {
  const parsed: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(input)) {
    const result = filterSearchValueSchema.safeParse(value);
    if (result.success) parsed[key] = result.data;
  }
  return parsed satisfies FilterSearch;
};

export interface FilterSpecCore {
  columnId: string;
  field?: string;
  /**
   * URL search-param key. Defaults to `columnId`; override only to keep an
   * established link shape working (expenses' name filter is `?q=`).
   */
  urlKey?: string;
  kind: FilterKind;
  brand?: (value: string) => string;
  expand?: (value: string) => FilterPatch;
  /**
   * No table column renders this spec — it's URL state only: a deep link's
   * scope (expenses' `?productId=` and `?order=`), surfaced as a `ScopeChip`
   * and cleared by the page that owns the param.
   *
   * Such a spec is kept OUT of `columnFilters`. TanStack resolves every entry
   * there to a column and `console.error`s
   * `[Table] Column with id '<x>' does not exist.` for the ones it can't — on
   * every render, loud enough to bury real errors. It still reaches the server
   * filters: `useTableState` exposes it via `allFilters` (table pages) and
   * `filterGetterFromSearch` reads it straight from the URL (the table-less
   * analytics view). It's likewise excluded from `encodeFilters` and from the
   * keys `useTableState` writes through, since no column state can produce it.
   */
  urlOnly?: boolean;
  /**
   * Marks a picklist as covering a NULLABLE column: the control gains the two
   * sentinel options below, and the builder routes them to `field` (a
   * `presenceFilter`) instead of into the value list. `multiselect` / `idMulti`
   * only — a `presence` kind IS this filter, for relations with no picklist.
   *
   * `label` is the noun in "Has {label}".
   */
  nullable?: { field: string; label: string };
}

/**
 * Picklist sentinels for a nullable column.
 *
 * Double-underscored so they can't collide with anything a real option carries
 * — a uuid, an enum slug, or a user-authored tag. They never reach the wire:
 * `buildFiltersFromManifest` partitions them out and emits a `presenceFilter`
 * instead, so the runtime input schemas never see them.
 */
export const FILTER_ANY = "__any__";
export const FILTER_NONE = "__none__";

const isSentinel = (value: string): boolean =>
  value === FILTER_ANY || value === FILTER_NONE;

/**
 * The two options a `nullable` picklist prepends to its roster.
 *
 * `meta` renders them in the eyebrow register (mono/uppercase/slate, with a
 * rule beneath) so a predicate about the data doesn't read as a row of it.
 * `label` stays a plain string — `LedgerFilters` and the collapsed
 * multi-combobox summary interpolate it into `"(none) +2"`.
 */
export const nullableSentinelOptions = (
  label: string,
): Array<{ value: string; label: string; meta: true }> => [
  { value: FILTER_ANY, label: `Has ${label}`, meta: true },
  { value: FILTER_NONE, label: "(none)", meta: true },
];

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
 * the analytics view both build `ExpenseFilters`) would otherwise open two
 * cache entries holding identical results, and the UI flashes between them.
 * Everything funnels through here so one shape reaches the wire.
 */
const many = (value: FilterValue): string[] | undefined => {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values.length ? values : undefined;
};

const parseFilterValue = <TValue>(value: TValue): FilterValue => {
  const parsed = z
    .union([z.string(), z.array(z.string())])
    .optional()
    .safeParse(value);
  return parsed.success ? parsed.data : undefined;
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
) {
  const filters: FilterPatch = {};
  const brand = (spec: FilterSpecCore, value: string): string => {
    try {
      return spec.brand?.(value) ?? value;
    } catch {
      // A malformed or deleted public reference is still a requested
      // constraint. Keep it explicit so the repository resolves it to zero
      // rows instead of widening the list as though the URL had no filter.
      return UNRESOLVABLE_ENTITY_FILTER;
    }
  };

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
        const parsed = brand(spec, value);
        return { [field]: parsed };
      })
      .with("multiselect", "idMulti", () => {
        const values = many(raw);
        if (!values) return undefined;
        // Only `idMulti` carries a brand, so the two kinds share one arm.
        const brandAll = (items: string[]) =>
          items.map((value) => brand(spec, value));
        const nullable = spec.nullable;
        if (!nullable) {
          const parsed = brandAll(values);
          return parsed.length ? { [field]: parsed } : undefined;
        }

        // Partition BEFORE branding — a sentinel is not an entity id, and
        // `unsafe*Id` would happily brand the string into a lie.
        const [sentinels, rest] = partition(values, isSentinel);
        const wantsNone = sentinels.includes(FILTER_NONE);
        const wantsAny = sentinels.includes(FILTER_ANY);
        // `IS NULL OR IS NOT NULL` is every row, and the OR swallows any value
        // selection sitting alongside it — so both sentinels together mean no
        // constraint at all. Degenerate, but the control permits it.
        if (wantsNone && wantsAny) return undefined;
        const presence = wantsNone ? "none" : wantsAny ? "has" : undefined;
        const patch: FilterPatch = {};
        const parsed = brandAll(rest);
        if (parsed.length) patch[field] = parsed;
        if (presence) patch[nullable.field] = presence;
        return Object.keys(patch).length ? patch : undefined;
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

/**
 * Does one cell value satisfy a multiselect column filter?
 *
 * Sentinels mirror `eqAnyOrPresence` server-side, including its OR rule:
 * `["projA", FILTER_NONE]` is "project A *or* unassigned", not a contradiction.
 */
function matchesMultiSelect<TFilterValue>(
  value: string | null | undefined,
  filterValue: TFilterValue,
): boolean {
  const selected = parseFilterValue(filterValue);
  if (!Array.isArray(selected) || selected.length === 0) return true;
  // "" counts as absent: clearing an inline text edit writes an empty string,
  // and the `(none)` option has to find those rows too.
  const isEmpty = value == null || value === "";

  const wantsNone = selected.includes(FILTER_NONE);
  const wantsAny = selected.includes(FILTER_ANY);
  // Both sentinels together are `IS NULL OR IS NOT NULL` — every row.
  if (wantsNone && wantsAny) return true;
  if (wantsNone && isEmpty) return true;
  if (wantsAny && !isEmpty) return true;

  return !isEmpty && selected.includes(value);
}

/**
 * Builds a client-side filterFn for a multiselect column over an arbitrary cell
 * shape. `read` narrows the raw cell value to the string the roster holds — the
 * project column's accessor yields `{id, name}`, so it reads `.id`.
 *
 * A factory rather than a 4th parameter: TanStack's `FilterFn` signature already
 * claims that slot for `addMeta`.
 */
export const multiSelectFilterFnBy =
  <TCellValue, TFilterValue>(
    read: (value: TCellValue) => string | null | undefined,
  ) =>
  (
    row: { getValue: (id: string) => TCellValue },
    columnId: string,
    filterValue: TFilterValue,
  ): boolean =>
    matchesMultiSelect(read(row.getValue(columnId)), filterValue);

/**
 * Client-side filterFn for a multiselect column whose cell value is the roster
 * string itself.
 *
 * Required, not optional, on every client-side table. TanStack picks a filterFn
 * from the ROW value's type, not the filter value's — a string column handed
 * `["a","b"]` resolves to `includesString`, which tests
 * `String(rowValue).includes("a,b")` and so matches nothing, silently. Server
 * tables (`manualFiltering: true`) never run this.
 */
export const multiSelectFilterFn = multiSelectFilterFnBy((v) =>
  v == null ? null : String(v),
);

/** Kinds whose column-filter state is an array rather than a scalar. */
const MULTI_KINDS: ReadonlySet<FilterKind> = new Set<FilterKind>([
  "multiselect",
  "idMulti",
]);

export const isMultiFilterKind = (kind: FilterKind): boolean =>
  MULTI_KINDS.has(kind);

/**
 * The single value of a `oneOrMany` filter, or undefined when it holds a set.
 *
 * For UI that can only mirror one value — the expenses analytics matrix
 * highlights a single (trade, costType) cell, so a multi-trade filter has no
 * cell to light up.
 */
export const soleValue = <T>(value: T | T[] | undefined): T | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return value;
  return value.length === 1 ? value[0] : undefined;
};

//
// Filters live in the URL so a filtered view is shareable, bookmarkable, and
// survives a reload. Sets are comma-joined (`?trade=drywall,electrical`),
// matching the `sort=name,-createdAt` convention already used for sorting.
//
// TanStack Router's default `stringifySearch` JSON-encodes a non-string value,
// which would give `?trade=%5B%22drywall%22%2C...%5D`. There's no custom
// parseSearch/stringifySearch on this router, so arrays are joined on write and
// split on read here — uniformly, from the manifest, so no two keys can end up
// encoding differently.

const LIST_SEPARATOR = ",";

/** The one search-param key a spec reads and writes. */
export const filterUrlKey = (
  spec: Pick<FilterSpecCore, "urlKey" | "columnId">,
): string => spec.urlKey ?? spec.columnId;

/**
 * `[column-backed, url-only]`.
 *
 * The first list is everything a table's `columnFilters` may hold — the only
 * specs `useTableState` decodes into state, encodes back out, or claims a URL
 * key for. See `urlOnly` on the spec for why the second list is held apart.
 */
export const partitionFilterSpecs = (
  specs: readonly FilterSpecCore[],
): [FilterSpecCore[], FilterSpecCore[]] =>
  partition(specs, (spec) => !spec.urlOnly);

/**
 * Everything a table needs to move filters between state and the URL,
 * compiled once from an entity's specs: which specs back columns and which
 * are URL-only scopes, the exact search-param keys each side owns, and the
 * encode/decode over them. Ownership and encoding come from the same walk,
 * so a table can never claim (or delete) a key it does not encode.
 */
export interface FilterCodec {
  readonly columnSpecs: readonly FilterSpecCore[];
  readonly urlOnlySpecs: readonly FilterSpecCore[];
  /** Search-param keys the table owns — it may write and clear these. */
  readonly columnKeys: readonly string[];
  /** Search-param keys only navigation may change; a table never deletes them. */
  readonly urlOnlyKeys: readonly string[];
  encode(
    get: (columnId: string) => FilterValue,
  ): Record<string, string | undefined>;
  decodeColumns<TSearch extends {}>(search: TSearch): ColumnFilterValue[];
  decodeUrlOnly<TSearch extends {}>(search: TSearch): ColumnFilterValue[];
}

export type ColumnFilterValue = { id: string; value: string | string[] };

export const compileFilterCodec = (
  specs: readonly FilterSpecCore[],
): FilterCodec => {
  const [columnSpecs, urlOnlySpecs] = partitionFilterSpecs(specs);
  return {
    columnSpecs,
    urlOnlySpecs,
    columnKeys: columnSpecs.map(filterUrlKey),
    urlOnlyKeys: urlOnlySpecs.map(filterUrlKey),
    encode: (get) => encodeFilters(columnSpecs, get),
    decodeColumns: (search) => decodeFilters(columnSpecs, search),
    decodeUrlOnly: (search) => decodeFilters(urlOnlySpecs, search),
  };
};

/** Column-filter state → search params. Absent keys mean "not filtered". */
export function encodeFilters(
  specs: readonly FilterSpecCore[],
  get: (columnId: string) => FilterValue,
) {
  const params: Record<string, string | undefined> = {};
  for (const spec of specs) {
    const raw = get(spec.columnId);
    const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
    // undefined, never "" — `stripSearchParams` only strips on undefined, so
    // an empty string would stick in the URL forever.
    params[filterUrlKey(spec)] = values.length
      ? values.join(LIST_SEPARATOR)
      : undefined;
  }
  return params;
}

/** Search params → column-filter state, shaped per each spec's `kind`. */
export function decodeFilters<TSearch extends {}>(
  specs: readonly FilterSpecCore[],
  search: TSearch,
): ColumnFilterValue[] {
  const parsedSearch = parseFilterSearch(search);
  const filters: ColumnFilterValue[] = [];
  for (const spec of specs) {
    const raw = parsedSearch[filterUrlKey(spec)];
    if (raw === undefined || raw === "") continue;
    const parts = raw
      .split(LIST_SEPARATOR)
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length === 0) continue;
    const first = parts[0];
    if (first === undefined) continue;
    filters.push({
      id: spec.columnId,
      // A multi column always holds an array, even for one value — mixing the
      // two shapes is what splits the React Query cache.
      value: isMultiFilterKind(spec.kind) ? parts : first,
    });
  }
  return filters;
}

/**
 * The two ways a caller gets at a column's filter value, as adapters for
 * {@link buildFiltersFromManifest}'s `get`.
 *
 * Three sites build the same `specs → get → buildFiltersFromManifest`
 * sequence and must agree, because the ledger table and the analytics view
 * call the same procedure and any disagreement silently opens a second React
 * Query cache entry (see the note on `many` above). They differ only in where
 * the value comes from — live table state, or the URL when no table is
 * mounted. Naming both makes that the whole difference, rather than three
 * hand-rolled lookups that happen to match.
 */
export const filterGetterFromColumnFilters =
  <TFilterValue>(
    columnFilters: ReadonlyArray<{ id: string; value: TFilterValue }>,
  ) =>
  (columnId: string): FilterValue =>
    (() => {
      const raw = columnFilters.find((f) => f.id === columnId)?.value;
      return parseFilterValue(raw);
    })();

export function filterGetterFromSearch<TSearch extends {}>(
  specs: readonly FilterSpecCore[],
  search: TSearch,
): (columnId: string) => FilterValue {
  const decoded = new Map(
    decodeFilters(specs, search).map((f) => [f.id, f.value]),
  );
  return (columnId) => decoded.get(columnId);
}

/**
 * Options for a relation-presence filter: pages map the selected value
 * ("has" | "none") to the entity's `*PresenceFilter` field, resolved
 * server-side as an exists / is-null condition. Clearing it means "any".
 *
 * Lives here rather than with the column helpers so the manifest can build its
 * specs without a runtime import of the column layer (which drags in the whole
 * entity/rendering graph, WASM included).
 *
 * `meta: true` matches `nullableSentinelOptions` — both are predicates about
 * the data ("Has X" / "(none)"), not roster values, so both render in the
 * eyebrow register (mono/uppercase, rule beneath) rather than looking like an
 * ordinary picklist entry.
 */
export const presenceFilterOptions = (
  label: string,
): Array<{ value: string; label: string; meta: true }> => [
  { value: "has", label: `Has ${label}`, meta: true },
  { value: "none", label: "(none)", meta: true },
];

//
// Same shape as the filter round-trip above and, like it, needed by two callers
// that must agree: `useTableState` owns the live table state, and the tab-title
// summarizer reads the identical param straight from the URL with no table
// mounted. Kept here rather than in the table layer so the pure one has no
// React dependency to drag in.

/** One sort term. Structurally TanStack's `ColumnSort`, without the import. */
export interface SortTerm {
  id: string;
  desc: boolean;
}

/**
 * `[{id,desc},...]` → `name,-createdAt` (dash = descending); undefined if
 * empty. A single sort serializes byte-identically to the pre-multi-sort
 * format, so old URLs and the defaultSortParam comparison keep working.
 */
export function sortToParam(sorting: readonly SortTerm[]): string | undefined {
  if (sorting.length === 0) return undefined;
  return sorting.map((s) => `${s.desc ? "-" : ""}${s.id}`).join(LIST_SEPARATOR);
}

/** `name,-createdAt` (or legacy single `name`/`-name`) → sort terms. */
export function paramToSort<TValue>(value: TValue): SortTerm[] | undefined {
  const parsedValue = filterSearchValueSchema.safeParse(value).data;
  if (parsedValue === undefined || parsedValue.length === 0) return undefined;
  const parsed = parsedValue
    .split(LIST_SEPARATOR)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => ({
      id: t.startsWith("-") ? t.slice(1) : t,
      desc: t.startsWith("-"),
    }))
    .filter((s) => s.id);
  return parsed.length ? parsed : undefined;
}

//
// Renders active filter state as short prose, for surfaces that have search
// params but no table instance — the browser tab title, which is built inside a
// route's `head` on the server. That's the constraint that shapes what follows:
// no React, no fetching, so a filter whose values are entity UUIDs can only be
// counted ("2 locations"), never named. Everything self-describing (text,
// static picklists, presence predicates) renders in full.

export { humanize } from "@cubby/shared";

/** Naive plural, sufficient for the entity nouns column ids are built from. */
const pluralize = (noun: string, count: number): string =>
  count === 1 || noun.endsWith("s") ? noun : `${noun}s`;

/** Beyond this many values a picklist collapses to `first, second +N`. */
const MAX_VALUES_PER_FILTER = 2;

/** Beyond this many filters the whole summary collapses to `… +N`. */
const MAX_SEGMENTS = 3;

/**
 * A spec plus the option roster the summarizer needs to name a picklist value.
 *
 * `options` lives on the richer `FilterSpec` in `filter-manifest.tsx` (it holds
 * icons, so it can't live in this module). Widening the parameter here rather
 * than importing that type keeps this file dependency-free while letting
 * callers pass `getEntityFilters(entity)` straight through — `FilterSpec`
 * structurally satisfies it.
 */
export type SummarizableSpec = FilterSpecCore & {
  options?: ReadonlyArray<{ value: string; label: string }>;
};

const optionLabel = (
  spec: SummarizableSpec,
  value: string,
): string | undefined =>
  spec.options?.find((option) => option.value === value)?.label;

/**
 * `Has UPC` / `No UPC` for a presence value.
 *
 * The noun comes from the spec's own `Has …` option rather than from the column
 * id, so casing the manifest already got right (`UPC`, not `Upc`) survives. The
 * `(none)` option label is deliberately not reused — it reads as an omission in
 * a list of values, but as nothing at all in a tab title.
 */
const describePresence = (spec: SummarizableSpec, value: string): string => {
  const noun =
    optionLabel(spec, "has")?.replace(/^has\s+/i, "") ??
    humanize(spec.columnId.replace(/Presence$/, "")).toLowerCase();
  return value === "none" ? `No ${noun}` : `Has ${noun}`;
};

/** `Has category` / `No category` for a nullable picklist's sentinel value. */
const describeSentinel = (label: string, value: string): string =>
  value === FILTER_NONE ? `No ${label}` : `Has ${label}`;

const collapse = (parts: string[], max: number): string => {
  const shown = parts.slice(0, max);
  const extra = parts.length - shown.length;
  return extra > 0 ? `${shown.join(", ")} +${extra}` : shown.join(", ");
};

/** One filter's values → one summary segment, or undefined to omit it. */
function describeFilter(
  spec: SummarizableSpec,
  values: string[],
): string | undefined {
  const first = values[0];
  if (first === undefined) return undefined;

  return (
    match(spec.kind)
      .with("text", () => first)
      // A range preset's value is a bare key (`30d`, `ytd`) that means nothing on
      // its own — the roster label ("Last 30 days") is the whole point. Same shape
      // as `select`, so they share the lookup; `humanize` is only the fallback for
      // a spec whose options are supplied at runtime.
      .with(
        "select",
        "range",
        () => optionLabel(spec, first) ?? humanize(first),
      )
      .with("presence", () => describePresence(spec, first))
      .with("boolean", () => {
        const noun = humanize(spec.columnId);
        return first === "false" ? `No ${noun.toLowerCase()}` : noun;
      })
      .with("multiselect", () => {
        const [sentinels, rest] = partition(values, isSentinel);
        const labels = [
          ...rest.map((value) => optionLabel(spec, value) ?? value),
          ...(spec.nullable
            ? sentinels.map((value) =>
                describeSentinel(spec.nullable?.label ?? "", value),
              )
            : []),
        ];
        return labels.length
          ? collapse(labels, MAX_VALUES_PER_FILTER)
          : undefined;
      })
      .with("id", "idMulti", () => {
        // Values are entity UUIDs and their names are only resolvable at runtime,
        // so the count is the most this surface can honestly say.
        const [sentinels, rest] = partition(values, isSentinel);
        const parts = spec.nullable
          ? sentinels.map((value) =>
              describeSentinel(spec.nullable?.label ?? "", value),
            )
          : [];
        if (rest.length) {
          const noun = humanize(spec.columnId).toLowerCase();
          parts.unshift(`${rest.length} ${pluralize(noun, rest.length)}`);
        }
        return parts.length ? parts.join(", ") : undefined;
      })
      .exhaustive()
  );
}

/**
 * Active filters in the URL → short human-readable segments.
 *
 * Reads through {@link decodeFilters} so the summary can never disagree with
 * what the table actually filtered by: same specs, same `urlKey` resolution,
 * same comma-splitting.
 */
function summarizeFilters(
  specs: readonly SummarizableSpec[],
  search: FilterSearch,
): string[] {
  const byColumnId = new Map(specs.map((spec) => [spec.columnId, spec]));
  const segments: string[] = [];

  for (const { id, value } of decodeFilters(specs, search)) {
    const spec = byColumnId.get(id);
    if (!spec) continue;
    const segment = describeFilter(
      spec,
      Array.isArray(value) ? value : [value],
    );
    if (segment) segments.push(segment);
  }

  return segments;
}

/** `-price` → `↓price`; `name,-createdAt` → `↑name ↓createdAt`. */
function summarizeSort(value: string | undefined): string | undefined {
  const terms = paramToSort(value);
  if (!terms) return undefined;
  return terms.map((term) => `${term.desc ? "↓" : "↑"}${term.id}`).join(" ");
}

/**
 * The whole of a list page's active state as one string: filters first, then
 * sort. Empty when the page is unnarrowed and unsorted, which is what makes the
 * caller's title collapse back to a bare `Products | cubby`.
 */
export function summarizeListState<TSearch extends {}>(
  specs: readonly SummarizableSpec[],
  search: TSearch,
): string | undefined {
  const parsedSearch = parseFilterSearch(search);
  const filters = summarizeFilters(specs, parsedSearch);
  const sort = summarizeSort(parsedSearch.sort);
  const summary = [collapse(filters, MAX_SEGMENTS), sort]
    .filter(Boolean)
    .join(" ");
  return summary || undefined;
}
