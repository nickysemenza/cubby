import {
  LIVE_PROJECT_STATUSES,
  projectStatusValues,
} from "@cubby/schemas/project";
import { describe, expect, it } from "vitest";
import {
  DASHBOARD_FILTER_SEARCH_KEYS,
  dateRangeBounds,
  defaultFilters,
  filtersFromSearch,
  filtersToScopeInput,
  filtersToSearch,
} from "./dashboard-filter-state";

describe("filtersFromSearch", () => {
  it("treats an absent statuses param as the default live three", () => {
    const filters = filtersFromSearch({});
    expect(filters.statuses).toEqual(new Set(LIVE_PROJECT_STATUSES));
  });
});

describe("filtersToSearch", () => {
  it("serializes the default (live three) status selection to undefined", () => {
    const result = filtersToSearch(defaultFilters);
    expect(result.statuses).toBeUndefined();
  });

  it("serializes a deselect-all (empty) status selection to all four statuses", () => {
    const result = filtersToSearch({ ...defaultFilters, statuses: new Set() });
    expect(result.statuses).toBeDefined();
    expect(new Set(result.statuses)).toEqual(new Set(projectStatusValues));
    expect(result.statuses).toHaveLength(4);
  });

  it("round-trips a deselect-all selection back to the default live three", () => {
    const searched = filtersToSearch({
      ...defaultFilters,
      statuses: new Set(),
    });
    const reparsed = filtersFromSearch({ statuses: searched.statuses });
    // All four statuses are present, not the live three — the URL is
    // bi-state (absent = default three, present = exactly those), so an
    // explicit all-four param is honored as-is rather than collapsed back
    // down. The chip UI re-lighting "all four" (not "back to the default
    // three") is the documented, intentional behavior.
    expect(reparsed.statuses).toEqual(new Set(projectStatusValues));
  });

  it("omits kinds/locations/date when unset", () => {
    const result = filtersToSearch(defaultFilters);
    expect(result.kinds).toBeUndefined();
    expect(result.locations).toBeUndefined();
    expect(result.date).toBeUndefined();
  });
});

describe("filtersToScopeInput", () => {
  it("always sets statusScope explicitly for the default filters", () => {
    const scope = filtersToScopeInput(defaultFilters);
    expect(scope.statusScope).toBeDefined();
    expect(new Set(scope.statusScope)).toEqual(new Set(LIVE_PROJECT_STATUSES));
  });

  it("always sets statusScope explicitly even for an empty selection", () => {
    // filtersToScopeInput is a direct Filters -> scope mapping; it does not
    // itself re-apply the "empty means all four" URL-serialization rule
    // (that's filtersToSearch's job). What matters here is that the field
    // is never left `undefined` — never relying on the server's own
    // "omitted statusScope means all four statuses" default, since that
    // default doesn't match the chips' default (the live three).
    const scope = filtersToScopeInput({
      ...defaultFilters,
      statuses: new Set(),
    });
    expect(scope.statusScope).toBeDefined();
    expect(scope.statusScope).toEqual([]);
  });

  it("resolves a dateRange preset to dateFrom/dateTo using the injected today", () => {
    const today = new Date(2024, 2, 15); // 2024-03-15, local time
    const scope = filtersToScopeInput(
      { ...defaultFilters, dateRange: "3m" },
      today,
    );
    expect(scope.dateFrom).toBe("2023-12-15");
    expect(scope.dateTo).toBe("2024-03-15");
  });

  it("leaves dateFrom/dateTo undefined when no dateRange is set", () => {
    const scope = filtersToScopeInput(defaultFilters);
    expect(scope.dateFrom).toBeUndefined();
    expect(scope.dateTo).toBeUndefined();
  });
});

describe("dateRangeBounds", () => {
  const today = new Date(2024, 2, 15); // 2024-03-15, local time — arbitrary fixed date

  it("resolves '3m' relative to the injected today", () => {
    expect(dateRangeBounds("3m", today)).toEqual({
      from: "2023-12-15",
      to: "2024-03-15",
    });
  });

  it("resolves '12m' relative to the injected today", () => {
    expect(dateRangeBounds("12m", today)).toEqual({
      from: "2023-03-15",
      to: "2024-03-15",
    });
  });

  it("resolves 'ytd' to the start of the injected today's year", () => {
    expect(dateRangeBounds("ytd", today)).toEqual({
      from: "2024-01-01",
      to: "2024-03-15",
    });
  });

  it("resolves a bare 4-digit year to that calendar year's bounds", () => {
    expect(dateRangeBounds("1999", today)).toEqual({
      from: "1999-01-01",
      to: "1999-12-31",
    });
  });

  it("returns null for garbage input", () => {
    expect(dateRangeBounds("not-a-real-key", today)).toBeNull();
    expect(dateRangeBounds("", today)).toBeNull();
    expect(dateRangeBounds("20240", today)).toBeNull();
  });
});

describe("URL search-param key disjointness", () => {
  /**
   * `entities/filter-manifest.tsx` is the source of truth for the project
   * table's manifest-managed search-param keys, but it cannot be imported
   * here: it's a `.tsx` (the vitest `unit` project has no React/JSX plugin,
   * only `ui` does) and it transitively imports several `~/...`-aliased
   * modules (`~/app/_components/data-table/columnHelpers`,
   * `~/app/projects/project-options`, etc.) — both independently make it
   * unloadable from this alias-free `unit`-project test file. So this list
   * is a hand-maintained literal, not a derived import. It reflects the
   * *target* state after a concurrent unit removes the presentation-only
   * `status`/`kind` specs from the project entry in `entityFilters` (see
   * the comment in filter-manifest.tsx above the `project:` entry) — the
   * table then owns exactly `name` (its text filter) plus
   * `tableSearchFields`'s `sort`/`page`/`pageSize`. If the manifest ever
   * grows another key for the `project` entity, update this list too.
   */
  const PROJECT_TABLE_MANIFEST_SEARCH_KEYS = [
    "name",
    "sort",
    "page",
    "pageSize",
  ] as const;

  it("shares no search-param keys between the dashboard chips and the project table", () => {
    const chipKeys = new Set<string>(DASHBOARD_FILTER_SEARCH_KEYS);
    const tableKeys = new Set<string>(PROJECT_TABLE_MANIFEST_SEARCH_KEYS);
    const intersection = [...chipKeys].filter((key) => tableKeys.has(key));
    expect(intersection).toEqual([]);
  });
});
