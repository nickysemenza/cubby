import { describe, expect, it } from "vitest";

import {
  activeFilterCount,
  dateRangeBounds,
  defaultFilters,
  type Filters,
  filtersFromSavedViewFilters,
  filtersFromSearch,
  filtersToScopeInput,
  filtersToSearch,
  hasActiveFilters,
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

describe("active filter affordance", () => {
  it("stays quiet for bare /projects", () => {
    expect(hasActiveFilters(defaultFilters)).toBe(false);
    expect(activeFilterCount(defaultFilters)).toBe(0);
  });

  it("counts each active scope constraint", () => {
    const filters: Filters = {
      ...defaultFilters,
      statuses: new Set(["in_progress"]),
      kinds: new Set(["household"]),
      locations: new Set(["Garage", "Kitchen"]),
      dateRange: "3m",
    };
    expect(hasActiveFilters(filters)).toBe(true);
    expect(activeFilterCount(filters)).toBe(5);
  });
});

describe("saved project views", () => {
  it("restores every dashboard-owned filter", () => {
    const filters = filtersFromSavedViewFilters([
      { id: "status", value: ["in_progress"] },
      { id: "kind", value: ["household"] },
      { id: "locations", value: ["Kitchen"] },
      { id: "dateRange", value: "3m" },
      { id: "completionYear", value: "2025" },
    ]);

    expect([...filters.statuses]).toEqual(["in_progress"]);
    expect([...filters.kinds]).toEqual(["household"]);
    expect([...filters.locations]).toEqual(["Kitchen"]);
    expect(filters.dateRange).toBe("3m");
    expect(filters.completionYear).toBe("2025");
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
