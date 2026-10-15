/**
 * Pure state layer for the /projects dashboard filter bar: URL search params
 * <-> `Filters` <-> workflow scope input. No React, no `~` imports — this module
 * must be loadable by vitest's `unit` project, which cannot resolve the `~`
 * alias into a `.tsx`/`.ts` file. Only `@cubby/schemas/*` and `date-fns` are
 * allowed as imports here.
 */
import {
  projectKindSchema,
  projectStatusSchema,
  type ProjectKind,
  type ProjectStatus,
} from "@cubby/schemas/project";
import { format, startOfYear, subMonths } from "date-fns";
import { z } from "zod";

export type Filters = {
  statuses: Set<ProjectStatus>;
  kinds: Set<ProjectKind>;
  locations: Set<string>;
  /** Preset key ("3m" | "12m" | "ytd") or a 4-digit year; null = all time. */
  dateRange: string | null;
  completionYear: string | null;
};

/**
 * The URL shape the generated `/projects` search validates into — the
 * fields this filter bar owns. List values are comma-joined strings, the
 * manifest's `urlEnumListParam` encoding.
 */
export type FilterSearchParams = {
  statuses?: string;
  kinds?: string;
  locations?: string;
  date?: string;
  completed?: string;
};

/** The search-param serialization of a `Filters` value — same shape as
 * `FilterSearchParams`, produced by `filtersToSearch`. */
export type FilterSearchOutput = {
  statuses: string | undefined;
  kinds: string | undefined;
  locations: string | undefined;
  date: string | undefined;
  completed: string | undefined;
};

const splitList = (value: string | undefined): string[] =>
  value ? value.split(",").filter((item) => item.length > 0) : [];
const joinList = (values: ReadonlySet<string>): string | undefined =>
  values.size > 0 ? [...values].join(",") : undefined;

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

/** The dashboard's resting state has no record-membership restriction. */
export const defaultFilters: Filters = {
  statuses: new Set(),
  kinds: new Set(),
  locations: new Set(),
  dateRange: null,
  completionYear: null,
};

/** An empty selection is the unfiltered status state. */
function isDefaultStatusSelection(filters: Filters): boolean {
  return filters.statuses.size === 0;
}

/** True when the URL scope differs from bare `/projects`. */
export function hasActiveFilters(filters: Filters): boolean {
  return (
    !isDefaultStatusSelection(filters) ||
    filters.kinds.size > 0 ||
    filters.locations.size > 0 ||
    filters.dateRange !== null ||
    filters.completionYear !== null
  );
}

/** Number shown in the compact toolbar affordance. Multi-select values count
 * independently so the number never understates the active scope. */
export function activeFilterCount(filters: Filters): number {
  return (
    filters.statuses.size +
    filters.kinds.size +
    filters.locations.size +
    Number(filters.dateRange !== null) +
    Number(filters.completionYear !== null)
  );
}

type SavedFilterValue = string | string[] | null;
type SavedFilter = { id: string; value: SavedFilterValue };

/** Restore every dashboard-owned saved-view field without letting stale or
 * foreign table values leak into the typed URL scope. */
export function filtersFromSavedViewFilters(
  savedFilters: SavedFilter[],
): Filters {
  const value = (id: string) =>
    savedFilters.find((filter) => filter.id === id)?.value;
  const arrayValue = (id: string): string[] => {
    const candidate = value(id);
    return Array.isArray(candidate) ? candidate : [];
  };
  const dateRange = value("dateRange");
  const completionYear = value("completionYear");
  const parsedDateRange = z.string().safeParse(dateRange);
  const parsedCompletionYear = z.string().safeParse(completionYear);
  const statuses = arrayValue("status")
    .map((item) => projectStatusSchema.safeParse(item).data)
    .filter((item): item is ProjectStatus => item !== undefined);
  const kinds = arrayValue("kind")
    .map((item) => projectKindSchema.safeParse(item).data)
    .filter((item): item is ProjectKind => item !== undefined);

  return {
    statuses: new Set(statuses),
    kinds: new Set(kinds),
    locations: new Set(arrayValue("locations")),
    dateRange: parsedDateRange.success ? parsedDateRange.data : null,
    completionYear: parsedCompletionYear.success
      ? parsedCompletionYear.data
      : null,
  };
}

/** Parse ordinary URL filters. Absent means unrestricted. */
export function filtersFromSearch(search: FilterSearchParams): Filters {
  return {
    statuses: new Set(
      splitList(search.statuses).flatMap((item) => {
        const parsed = projectStatusSchema.safeParse(item);
        return parsed.success ? [parsed.data] : [];
      }),
    ),
    kinds: new Set(
      splitList(search.kinds).flatMap((item) => {
        const parsed = projectKindSchema.safeParse(item);
        return parsed.success ? [parsed.data] : [];
      }),
    ),
    locations: new Set(splitList(search.locations)),
    dateRange: search.date ?? null,
    completionYear: search.completed ?? null,
  };
}

/**
 * Serialize `Filters` back to search params for `navigate({ search })`.
 *
 * Empty/omitted fields always serialize as absent and add no server
 * restriction. This is the invariant behind bare `/projects`.
 */
export function filtersToSearch(filters: Filters): FilterSearchOutput {
  return {
    statuses: joinList(filters.statuses),
    kinds: joinList(filters.kinds),
    locations: joinList(filters.locations),
    date: filters.dateRange ?? undefined,
    completed: filters.completionYear ?? undefined,
  };
}

/** The shared scope input both `project.dashboardSummary` and
 * `project.portfolioAnalytics` accept (see `projectDashboardFiltersSchema`
 * in `@cubby/schemas/project`). */
export type ScopeInput = {
  statusScope: ProjectStatus[] | undefined;
  kinds: ProjectKind[] | undefined;
  locations: string[] | undefined;
  dateFrom: string | undefined;
  dateTo: string | undefined;
  completionYear: string | undefined;
};

/**
 * Map `Filters` to the workflow scope input. Empty status state remains omitted
 * and therefore unrestricted. `dateRange` resolves to `dateFrom`/`dateTo` via
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
    statusScope: filters.statuses.size > 0 ? [...filters.statuses] : undefined,
    kinds: filters.kinds.size > 0 ? [...filters.kinds] : undefined,
    locations: filters.locations.size > 0 ? [...filters.locations] : undefined,
    dateFrom: bounds?.from,
    dateTo: bounds?.to,
    completionYear: filters.completionYear ?? undefined,
  };
}
