import { describe, expect, it } from "vitest";
import {
  buildFiltersFromManifest,
  FILTER_ANY,
  FILTER_NONE,
  type FilterSpecCore,
  type FilterValue,
  isMultiFilterKind,
  multiSelectFilterFn,
  multiSelectFilterFnBy,
  nullableSentinelOptions,
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

    describe("nullable sentinels", () => {
      const specs: FilterSpecCore[] = [
        {
          columnId: "category",
          field: "categoryFilters",
          kind: "multiselect",
          nullable: { field: "categoryPresence", label: "Category" },
        },
      ];

      it("passes real values through untouched when no sentinel is selected", () => {
        expect(
          buildFiltersFromManifest(specs, getter({ category: ["a", "b"] })),
        ).toEqual({ categoryFilters: ["a", "b"] });
      });

      it("routes a lone __none__ to the nullable field as a presence filter", () => {
        expect(
          buildFiltersFromManifest(specs, getter({ category: [FILTER_NONE] })),
        ).toEqual({ categoryPresence: "none" });
      });

      it("routes a lone __any__ to the nullable field as a presence filter", () => {
        expect(
          buildFiltersFromManifest(specs, getter({ category: [FILTER_ANY] })),
        ).toEqual({ categoryPresence: "has" });
      });

      it("keeps both the values and the presence field when one sentinel rides along with real values", () => {
        expect(
          buildFiltersFromManifest(
            specs,
            getter({ category: ["a", FILTER_NONE] }),
          ),
        ).toEqual({ categoryFilters: ["a"], categoryPresence: "none" });
      });

      it("drops the constraint entirely when both sentinels are selected", () => {
        // IS NULL OR IS NOT NULL is every row, so selecting both sentinels
        // means no constraint at all -- not a filter matching everything.
        expect(
          buildFiltersFromManifest(
            specs,
            getter({ category: [FILTER_ANY, FILTER_NONE] }),
          ),
        ).toEqual({});
      });

      it("still drops the constraint when values ride along with both sentinels", () => {
        // The OR swallows any value selection sitting next to it, so this
        // must produce no filter at all, not `{ categoryFilters: ["a"] }`.
        expect(
          buildFiltersFromManifest(
            specs,
            getter({ category: ["a", FILTER_ANY, FILTER_NONE] }),
          ),
        ).toEqual({});
      });

      it("never brands a sentinel, only the real ids alongside it", () => {
        const idSpecs: FilterSpecCore[] = [
          {
            columnId: "project",
            field: "projectId",
            kind: "idMulti",
            // A brand that would visibly mangle a sentinel if it slipped
            // through unpartitioned.
            brand: (v) => ({ branded: v }),
            nullable: { field: "projectPresence", label: "Project" },
          },
        ];
        expect(
          buildFiltersFromManifest(
            idSpecs,
            getter({ project: ["p1", FILTER_NONE] }),
          ),
        ).toEqual({
          projectId: [{ branded: "p1" }],
          projectPresence: "none",
        });
      });

      it("normalizes a bare sentinel scalar into the presence patch", () => {
        // Same load-bearing scalar-to-array normalization as the plain
        // multiselect case above -- a nullable filter's stored state can
        // still arrive as a scalar string, and `many()` must fold it into a
        // one-element array before partitioning so it produces the same
        // patch as the array form (React Query key stability).
        expect(
          buildFiltersFromManifest(specs, getter({ category: FILTER_NONE })),
        ).toEqual({ categoryPresence: "none" });
      });

      it("leaves sentinel-shaped strings as ordinary values when the spec isn't nullable", () => {
        const plainSpecs: FilterSpecCore[] = [
          { columnId: "tags", field: "tagFilters", kind: "multiselect" },
        ];
        expect(
          buildFiltersFromManifest(plainSpecs, getter({ tags: [FILTER_NONE] })),
        ).toEqual({ tagFilters: [FILTER_NONE] });
      });
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

describe("nullableSentinelOptions", () => {
  it("returns the has/none sentinel pair, both flagged as meta options", () => {
    expect(nullableSentinelOptions("Category")).toEqual([
      { value: FILTER_ANY, label: "Has Category", meta: true },
      { value: FILTER_NONE, label: "(none)", meta: true },
    ]);
  });
});

describe("multiSelectFilterFn", () => {
  /** Minimal stand-in for a TanStack row. */
  const row = (value: unknown) => ({ getValue: () => value });
  const run = (
    value: unknown,
    filterValue: unknown,
    read?: (v: unknown) => string | null | undefined,
  ) =>
    (read ? multiSelectFilterFnBy(read) : multiSelectFilterFn)(
      row(value),
      "col",
      filterValue,
    );

  it("passes every row when nothing is selected", () => {
    expect(run("Amazon", undefined)).toBe(true);
    expect(run("Amazon", [])).toBe(true);
  });

  it("matches a value in the selected set, exactly", () => {
    expect(run("Amazon", ["Amazon", "eBay"])).toBe(true);
    expect(run("Lowe's", ["Amazon", "eBay"])).toBe(false);
    // Exact, not substring — the whole point of the eqAny move server-side.
    expect(run("Amazon Business", ["Amazon"])).toBe(false);
  });

  it("finds empty rows via (none), and only those", () => {
    expect(run(null, [FILTER_NONE])).toBe(true);
    expect(run(undefined, [FILTER_NONE])).toBe(true);
    // Clearing an inline text edit writes "", which is absent for our purposes.
    expect(run("", [FILTER_NONE])).toBe(true);
    expect(run("Amazon", [FILTER_NONE])).toBe(false);
  });

  it("finds non-empty rows via Has x", () => {
    expect(run("Amazon", [FILTER_ANY])).toBe(true);
    expect(run(null, [FILTER_ANY])).toBe(false);
  });

  it("ORs a sentinel with the value selection rather than ANDing", () => {
    // "Amazon or no vendor recorded" — mirrors eqAnyOrPresence server-side.
    expect(run("Amazon", ["Amazon", FILTER_NONE])).toBe(true);
    expect(run(null, ["Amazon", FILTER_NONE])).toBe(true);
    expect(run("eBay", ["Amazon", FILTER_NONE])).toBe(false);
  });

  it("treats both sentinels together as no constraint", () => {
    expect(run(null, [FILTER_ANY, FILTER_NONE])).toBe(true);
    expect(run("Amazon", [FILTER_ANY, FILTER_NONE])).toBe(true);
  });

  it("uses the accessor for object-valued columns", () => {
    // The regression: an entity-ref accessor ({id,name}) stringifies to
    // "[object Object]", so the roster matched nothing and (none) never found
    // an unassigned row on the embedded project-detail tables.
    const byId = (v: unknown) =>
      (v as { id?: string | null } | null)?.id ?? null;
    expect(run({ id: "p1", name: "Kitchen" }, ["p1"], byId)).toBe(true);
    expect(run({ id: "p2", name: "Bath" }, ["p1"], byId)).toBe(false);
    expect(run({ id: null, name: null }, [FILTER_NONE], byId)).toBe(true);
    expect(run({ id: "p1", name: "Kitchen" }, [FILTER_NONE], byId)).toBe(false);
  });
});
