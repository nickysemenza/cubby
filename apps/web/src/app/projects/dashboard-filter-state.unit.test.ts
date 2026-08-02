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
  it("treats an absent statuses param as unrestricted", () => {
    const filters = filtersFromSearch({});
    expect(filters.statuses).toEqual(new Set());
  });
});

describe("filtersToSearch", () => {
  it("serializes the unfiltered status selection to undefined", () => {
    const result = filtersToSearch(defaultFilters);
    expect(result.statuses).toBeUndefined();
  });

  it("serializes an empty status selection as no restriction", () => {
    const result = filtersToSearch({ ...defaultFilters, statuses: new Set() });
    expect(result.statuses).toBeUndefined();
  });

  it("round-trips an empty selection as unrestricted", () => {
    const searched = filtersToSearch({
      ...defaultFilters,
      statuses: new Set(),
    });
    const reparsed = filtersFromSearch({ statuses: searched.statuses });
    expect(reparsed.statuses).toEqual(new Set());
  });

  it("omits kinds/locations/date when unset", () => {
    const result = filtersToSearch(defaultFilters);
    expect(result.kinds).toBeUndefined();
    expect(result.locations).toBeUndefined();
    expect(result.date).toBeUndefined();
    expect(result.completed).toBeUndefined();
  });
});

describe("filtersToScopeInput", () => {
  it("leaves statusScope undefined for the unfiltered default", () => {
    const scope = filtersToScopeInput(defaultFilters);
    expect(scope.statusScope).toBeUndefined();
  });

  it("keeps an empty selection unrestricted", () => {
    // Empty is the ordinary no-restriction state in both the URL and API.
    const scope = filtersToScopeInput({
      ...defaultFilters,
      statuses: new Set(),
    });
    expect(scope.statusScope).toBeUndefined();
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

  it("forwards completion year independently of the activity date range", () => {
    const scope = filtersToScopeInput({
      ...defaultFilters,
      completionYear: "2024",
    });
    expect(scope.completionYear).toBe("2024");
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
    "statuses",
    "kinds",
    "locations",
    "date",
    "completed",
    "parent",
    "sort",
    "page",
    "pageSize",
  ] as const;

  it("uses the same URL keys in the dashboard and project list", () => {
    const tableKeys = new Set<string>(PROJECT_TABLE_MANIFEST_SEARCH_KEYS);
    expect(
      DASHBOARD_FILTER_SEARCH_KEYS.every((key) => tableKeys.has(key)),
    ).toBe(true);
  });
});
