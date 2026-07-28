import { describe, expect, it } from "vitest";
import {
  buildFiltersFromManifest,
  type FilterSpecCore,
  type FilterValue,
  isMultiFilterKind,
} from "./filters";

/** Reads from a plain record, mirroring `tableState.getColumnFilter`. */
const getter =
  (state: Record<string, FilterValue>) =>
  (columnId: string): FilterValue =>
    state[columnId];

describe("buildFiltersFromManifest", () => {
  it("renames a column to its server field, and omits what isn't set", () => {
    const specs: FilterSpecCore[] = [
      { columnId: "name", field: "nameFilter", kind: "text" },
      { columnId: "upc", field: "upcFilter", kind: "text" },
    ];
    expect(buildFiltersFromManifest(specs, getter({ name: "flour" }))).toEqual({
      nameFilter: "flour",
    });
  });

  it("defaults the server field to the column id", () => {
    const specs: FilterSpecCore[] = [{ columnId: "trade", kind: "select" }];
    expect(
      buildFiltersFromManifest(specs, getter({ trade: "drywall" })),
    ).toEqual({ trade: "drywall" });
  });

  it("treats an empty string as unset, not as a filter on ''", () => {
    const specs: FilterSpecCore[] = [{ columnId: "trade", kind: "select" }];
    expect(buildFiltersFromManifest(specs, getter({ trade: "" }))).toEqual({});
  });

  it("parses booleans, and ignores values that are neither", () => {
    const specs: FilterSpecCore[] = [{ columnId: "future", kind: "boolean" }];
    expect(buildFiltersFromManifest(specs, getter({ future: "true" }))).toEqual(
      { future: true },
    );
    expect(
      buildFiltersFromManifest(specs, getter({ future: "false" })),
    ).toEqual({ future: false });
    expect(buildFiltersFromManifest(specs, getter({ future: "yes" }))).toEqual(
      {},
    );
  });

  it("brands entity ids", () => {
    const specs: FilterSpecCore[] = [
      {
        columnId: "project",
        field: "projectId",
        kind: "id",
        brand: (v) => `branded:${v}`,
      },
    ];
    expect(
      buildFiltersFromManifest(specs, getter({ project: "proj_1" })),
    ).toEqual({ projectId: "branded:proj_1" });
  });

  it("expands a range preset into the pair of fields it owns", () => {
    const specs: FilterSpecCore[] = [
      {
        columnId: "date",
        kind: "range",
        expand: (v) => (v === "30d" ? { dateFrom: "A", dateTo: "B" } : {}),
      },
    ];
    expect(buildFiltersFromManifest(specs, getter({ date: "30d" }))).toEqual({
      dateFrom: "A",
      dateTo: "B",
    });
    expect(buildFiltersFromManifest(specs, getter({}))).toEqual({});
  });

  describe("multi-valued kinds", () => {
    const specs: FilterSpecCore[] = [
      { columnId: "tags", field: "tagFilters", kind: "multiselect" },
    ];

    it("passes an array straight through", () => {
      expect(
        buildFiltersFromManifest(specs, getter({ tags: ["a", "b"] })),
      ).toEqual({ tagFilters: ["a", "b"] });
    });

    it("normalizes a scalar up into a one-element array", () => {
      // Load-bearing: a scalar "a" and an array ["a"] are the same filter but
      // produce different React Query keys. Callers that build filters through
      // different paths must emit one shape or the cache splits.
      expect(buildFiltersFromManifest(specs, getter({ tags: "a" }))).toEqual({
        tagFilters: ["a"],
      });
    });

    it("collapses an empty array to absent, never an empty IN ()", () => {
      expect(buildFiltersFromManifest(specs, getter({ tags: [] }))).toEqual({});
    });

    it("brands every id in a multi set", () => {
      const idSpecs: FilterSpecCore[] = [
        {
          columnId: "project",
          field: "projectId",
          kind: "idMulti",
          brand: (v) => `branded:${v}`,
        },
      ];
      expect(
        buildFiltersFromManifest(idSpecs, getter({ project: ["p1", "p2"] })),
      ).toEqual({ projectId: ["branded:p1", "branded:p2"] });
    });
  });

  it("merges every spec into one object", () => {
    const specs: FilterSpecCore[] = [
      { columnId: "name", field: "search", kind: "text" },
      { columnId: "trade", kind: "multiselect" },
      { columnId: "future", kind: "boolean" },
      {
        columnId: "date",
        kind: "range",
        expand: () => ({ dateFrom: "2026-01-01", dateTo: "2026-12-31" }),
      },
    ];
    expect(
      buildFiltersFromManifest(
        specs,
        getter({
          name: "tile",
          trade: ["drywall", "electrical"],
          future: "false",
          date: "ytd",
        }),
      ),
    ).toEqual({
      search: "tile",
      trade: ["drywall", "electrical"],
      future: false,
      dateFrom: "2026-01-01",
      dateTo: "2026-12-31",
    });
  });
});

describe("isMultiFilterKind", () => {
  it("covers exactly the array-shaped kinds", () => {
    expect(isMultiFilterKind("multiselect")).toBe(true);
    expect(isMultiFilterKind("idMulti")).toBe(true);
    // "presence" is has/none — complements, so a multi-select there would mean
    // "no filter". Deliberately single.
    expect(isMultiFilterKind("presence")).toBe(false);
    expect(isMultiFilterKind("select")).toBe(false);
    expect(isMultiFilterKind("text")).toBe(false);
    expect(isMultiFilterKind("range")).toBe(false);
  });
});
