/**
 * Pure state layer for the /projects dashboard filter bar: URL search params
 * <-> `Filters` <-> tRPC scope input. No React, no `~` imports — this module
 * must be loadable by vitest's `unit` project, which cannot resolve the `~`
 * alias into a `.tsx`/`.ts` file. Only `@cubby/schemas/*` and `date-fns` are
 * allowed as imports here.
 */
import {
  LIVE_PROJECT_STATUSES,
  type ProjectStatus,
  projectStatusValues,
} from "@cubby/schemas/project";
import { format, startOfYear, subMonths } from "date-fns";

export type Filters = {
  statuses: Set<string>;
  kinds: Set<string>;
  locations: Set<string>;
  /** Preset key ("3m" | "12m" | "ytd") or a 4-digit year; null = all time. */
  dateRange: string | null;
};

/**
 * The URL shape the dashboard route validates search params into — a subset
 * of the route's full search schema (`projects.index.tsx`), just the fields
 * this filter bar owns.
 */
export type FilterSearchParams = {
  statuses?: string[];
  kinds?: string[];
  locations?: string[];
  date?: string;
};

/** The search-param serialization of a `Filters` value — same shape as
 * `FilterSearchParams`, produced by `filtersToSearch`. */
export type FilterSearchOutput = {
  statuses: string[] | undefined;
  kinds: string[] | undefined;
  locations: string[] | undefined;
  date: string | undefined;
};

/** The search-param keys this filter bar owns. Used to assert disjointness
 * against the project table's manifest-managed keys (see
 * `dashboard-filter-state.unit.test.ts`) — two filter systems now share the
 * `/projects` URL and must not collide on a key. */
export const DASHBOARD_FILTER_SEARCH_KEYS = [
  "statuses",
  "kinds",
  "locations",
  "date",
] as const;

export type DateRangeBounds = {
  /** Inclusive `YYYY-MM-DD` bounds — compare plain-date strings lexicographically. */
  from: string;
  to: string;
};

export const DATE_RANGE_PRESETS = [
  { key: "3m", label: "Last 3 months" },
  { key: "12m", label: "Last 12 months" },
  { key: "ytd", label: "This year" },
] as const;

/** Resolve a dateRange filter key to inclusive plain-date bounds. `today` is
 * injectable so this stays pure/testable — callers pass the real `new
 * Date()` at the call site; there is no module-level "now" constant. */
export function dateRangeBounds(
  key: string,
  today = new Date(),
): DateRangeBounds | null {
  const iso = (d: Date) => format(d, "yyyy-MM-dd");
  switch (key) {
    case "3m":
      return { from: iso(subMonths(today, 3)), to: iso(today) };
    case "12m":
      return { from: iso(subMonths(today, 12)), to: iso(today) };
    case "ytd":
      return { from: iso(startOfYear(today)), to: iso(today) };
    default:
      return /^\d{4}$/.test(key)
        ? { from: `${key}-01-01`, to: `${key}-12-31` }
        : null;
  }
}

/** The dashboard's resting state: the three "live" statuses selected, no
 * kind/location/date narrowing. Replaces the old `emptyFilters` (all-empty
 * Sets, nothing lit) — the chips now default to an honest reflection of what
 * the server actually scopes to on first load. */
export const defaultFilters: Filters = {
  statuses: new Set(LIVE_PROJECT_STATUSES),
  kinds: new Set(),
  locations: new Set(),
  dateRange: null,
};

/** True when `filters.statuses` is exactly the default live-three selection
 * (order-independent) — the state that should serialize to an absent
 * `statuses` URL param. */
export function isDefaultStatusSelection(filters: Filters): boolean {
  return (
    filters.statuses.size === LIVE_PROJECT_STATUSES.length &&
    LIVE_PROJECT_STATUSES.every((status) => filters.statuses.has(status))
  );
}

/** Parse the route's search params into `Filters`. An absent (or
 * catch-defaulted-to-undefined) `statuses` param means the default live
 * three, not "none selected" — the dashboard never actually shows zero
 * status chips lit on first load. */
export function filtersFromSearch(search: FilterSearchParams): Filters {
  return {
    statuses: new Set(search.statuses ?? LIVE_PROJECT_STATUSES),
    kinds: new Set(search.kinds ?? []),
    locations: new Set(search.locations ?? []),
    dateRange: search.date ?? null,
  };
}

/**
 * Serialize `Filters` back to search params for `navigate({ search })`.
 *
 * Bi-state for `statuses`: the URL is either absent (meaning the default
 * live three) or present with exactly the selected statuses. The default
 * three selection therefore serializes to `undefined` so the default URL
 * stays clean (`/projects`, no `statuses` query param).
 *
 * An **empty** selection (the user toggled off every status chip) does
 * *not* serialize to `[]` — there's no representation for "empty" in the
 * bi-state model above, and landing on `?statuses=` would read as "nothing
 * lit but every row still shows" once round-tripped back through
 * `filtersFromSearch` (which treats absent/empty as "give me the default").
 * Instead it serializes to *all four* statuses: deselecting the last chip
 * re-selects all four rather than landing on an empty set. This also means
 * the round trip through the URL is what actually re-lights the chips —
 * there's no separate "prevent going empty" logic in the toggle handler.
 */
export function filtersToSearch(filters: Filters): FilterSearchOutput {
  return {
    statuses: isDefaultStatusSelection(filters)
      ? undefined
      : filters.statuses.size === 0
        ? [...projectStatusValues]
        : [...filters.statuses],
    kinds: filters.kinds.size > 0 ? [...filters.kinds] : undefined,
    locations: filters.locations.size > 0 ? [...filters.locations] : undefined,
    date: filters.dateRange ?? undefined,
  };
}

/** The shared scope input both `project.dashboardSummary` and
 * `project.portfolioAnalytics` accept (see `projectDashboardFiltersSchema`
 * in `@cubby/schemas/project`). */
export type ScopeInput = {
  statusScope: ProjectStatus[];
  kinds: string[] | undefined;
  locations: string[] | undefined;
  dateFrom: string | undefined;
  dateTo: string | undefined;
};

/**
 * Map `Filters` to the tRPC scope input. `statusScope` is **always** sent
 * explicitly — never `undefined` — so the query never falls back to the
 * server's own default (an omitted `statusScope` means "no status
 * condition, i.e. all four statuses", per `projectDashboardFiltersSchema`'s
 * doc comment — that default does not match the chips' own default of "the
 * live three"). Relying on it would silently un-scope the dashboard's
 * default view. `dateRange` resolves to `dateFrom`/`dateTo` via
 * `dateRangeBounds`; `today` is injectable for the same testability reason
 * as `dateRangeBounds` itself.
 */
export function filtersToScopeInput(
  filters: Filters,
  today = new Date(),
): ScopeInput {
  const bounds = filters.dateRange
    ? dateRangeBounds(filters.dateRange, today)
    : null;
  return {
    statusScope: [...filters.statuses] as ProjectStatus[],
    kinds: filters.kinds.size > 0 ? [...filters.kinds] : undefined,
    locations: filters.locations.size > 0 ? [...filters.locations] : undefined,
    dateFrom: bounds?.from,
    dateTo: bounds?.to,
  };
}
