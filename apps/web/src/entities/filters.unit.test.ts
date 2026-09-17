import { UNRESOLVABLE_ENTITY_FILTER } from "@cubby/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  compileFilterCodec,
  buildFiltersFromManifest,
  FILTER_ANY,
  FILTER_NONE,
  type FilterSpecCore,
  type FilterSearch,
  type FilterValue,
  isMultiFilterKind,
  multiSelectFilterFn,
  multiSelectFilterFnBy,
  nullableSentinelOptions,
  paramToSort,
  presenceFilterOptions,
  type SummarizableSpec,
  sortToParam,
  summarizeListState,
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

  it("keeps an invalid public entity reference non-widening", () => {
    const specs: FilterSpecCore[] = [
      {
        columnId: "ingredientId",
        kind: "idMulti",
        brand: (value) => {
          if (value !== "ING-C2YH") throw new Error("bad shortcode");
          return value;
        },
      },
    ];
    expect(
      buildFiltersFromManifest(specs, getter({ ingredientId: "invalid" })),
    ).toEqual({ ingredientId: [UNRESOLVABLE_ENTITY_FILTER] });
    expect(
      buildFiltersFromManifest(specs, getter({ ingredientId: "ING-C2YH" })),
    ).toEqual({ ingredientId: ["ING-C2YH"] });
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
            brand: (v) => `branded:${v}`,
            nullable: { field: "projectPresence", label: "Project" },
          },
        ];
        expect(
          buildFiltersFromManifest(
            idSpecs,
            getter({ project: ["p1", FILTER_NONE] }),
          ),
        ).toEqual({
          projectId: ["branded:p1"],
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
  type EntityReference = {
    id?: string | null;
    name?: string | null;
  };
  type TestCellValue = string | null | undefined | EntityReference;
  const entityReferenceSchema = z.object({
    id: z.string().nullish(),
    name: z.string().nullish(),
  });
  const row = (value: TestCellValue) => ({ getValue: () => value });
  const run = (
    value: TestCellValue,
    filterValue: FilterValue,
    read?: (v: TestCellValue) => string | null | undefined,
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
    expect(run("Amazon Business", ["Amazon"])).toBe(false);
  });

  it("finds empty rows via (none), and only those", () => {
    expect(run(null, [FILTER_NONE])).toBe(true);
    expect(run(undefined, [FILTER_NONE])).toBe(true);
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
    const byId = (value: TestCellValue) => {
      const parsed = entityReferenceSchema.safeParse(value);
      return parsed.success ? (parsed.data.id ?? null) : null;
    };
    expect(run({ id: "p1", name: "Kitchen" }, ["p1"], byId)).toBe(true);
    expect(run({ id: "p2", name: "Bath" }, ["p1"], byId)).toBe(false);
    expect(run({ id: null, name: null }, [FILTER_NONE], byId)).toBe(true);
    expect(run({ id: "p1", name: "Kitchen" }, [FILTER_NONE], byId)).toBe(false);
  });
});

describe("summarizeListState", () => {
  const specs: SummarizableSpec[] = [
    { columnId: "name", kind: "text" },
    {
      columnId: "category",
      kind: "multiselect",
      options: [
        { value: "power-tools", label: "Power Tools" },
        { value: "fasteners", label: "Fasteners" },
        { value: "paint", label: "Paint" },
      ],
      nullable: { field: "categoryPresenceFilter", label: "category" },
    },
    {
      columnId: "upcPresence",
      kind: "presence",
      options: presenceFilterOptions("UPC"),
    },
    {
      // Hand-written options (not `presenceFilterOptions`), same as the real
      // product manifest entry — "Reviewed" isn't a "Has X" noun, so this
      // pins what the summarizer actually derives from a non-conforming label.
      columnId: "stockTracked",
      kind: "presence",
      options: [
        { value: "none", label: "Undecided" },
        { value: "has", label: "Reviewed" },
      ],
    },
    {
      columnId: "location",
      kind: "idMulti",
      nullable: { field: "inventoryPresenceFilter", label: "inventory" },
    },
    { columnId: "food", kind: "boolean" },
    {
      // Real preset keys, not readable stand-ins: a range value is a bare `30d`
      // whose meaning lives entirely in the roster label. An earlier fixture
      // used a self-describing `last-30-days`, which hid that the summarizer
      // was humanizing the key instead of looking the label up.
      columnId: "purchaseDate",
      kind: "range",
      options: [
        { value: "30d", label: "Last 30 days" },
        { value: "ytd", label: "Year to date" },
      ],
    },
    { columnId: "expenseTotal", kind: "range" },
    { columnId: "notes", urlKey: "q", kind: "text" },
  ];

  const summarize = (search: FilterSearch) => summarizeListState(specs, search);

  it("is undefined when nothing is filtered or sorted", () => {
    expect(summarize({})).toBeUndefined();
    expect(summarize({ name: "" })).toBeUndefined();
  });

  it("shows a text filter's value verbatim", () => {
    expect(summarize({ name: "packout" })).toBe("packout");
  });

  it("reads a filter through its urlKey, not its columnId", () => {
    expect(summarize({ q: "shim" })).toBe("shim");
    expect(summarize({ notes: "shim" })).toBeUndefined();
  });

  it("names picklist values by label and collapses past two", () => {
    expect(summarize({ category: "power-tools" })).toBe("Power Tools");
    expect(summarize({ category: "power-tools,fasteners" })).toBe(
      "Power Tools, Fasteners",
    );
    expect(summarize({ category: "power-tools,fasteners,paint" })).toBe(
      "Power Tools, Fasteners +1",
    );
  });

  it("renders a presence filter as Has/No, keeping the manifest's casing", () => {
    expect(summarize({ upcPresence: "has" })).toBe("Has UPC");
    expect(summarize({ upcPresence: "none" })).toBe("No UPC");
  });

  it("renders a presence filter with hand-written, non-'Has X' option labels", () => {
    expect(summarize({ stockTracked: "has" })).toBe("Has Reviewed");
    expect(summarize({ stockTracked: "none" })).toBe("No Reviewed");
  });

  it("renders nullable sentinels rather than leaking the raw token", () => {
    expect(summarize({ category: FILTER_ANY })).toBe("Has category");
    expect(summarize({ category: FILTER_NONE })).toBe("No category");
    expect(summarize({ category: `power-tools,${FILTER_NONE}` })).toBe(
      "Power Tools, No category",
    );
  });

  it("counts id filters, whose values are uuids it cannot name", () => {
    expect(summarize({ location: "loc-a" })).toBe("1 location");
    expect(summarize({ location: "loc-a,loc-b" })).toBe("2 locations");
    expect(summarize({ location: `loc-a,${FILTER_NONE}` })).toBe(
      "1 location, No inventory",
    );
  });

  it("renders booleans", () => {
    expect(summarize({ food: "true" })).toBe("Food");
    expect(summarize({ food: "false" })).toBe("No food");
  });

  it("names a range preset by its label, never the bare key", () => {
    expect(summarize({ purchaseDate: "30d" })).toBe("Last 30 days");
    expect(summarize({ purchaseDate: "ytd" })).toBe("Year to date");
    expect(summarize({ expenseTotal: "gte100" })).toBe("Gte100");
  });

  it("appends sort direction", () => {
    expect(summarize({ sort: "-price" })).toBe("↓price");
    expect(summarize({ sort: "name" })).toBe("↑name");
    expect(summarize({ sort: "name,-createdAt" })).toBe("↑name ↓createdAt");
    expect(summarize({ name: "packout", sort: "-price" })).toBe(
      "packout ↓price",
    );
  });

  it("collapses past three filter segments, keeping sort visible", () => {
    expect(
      summarize({
        name: "packout",
        category: "paint",
        upcPresence: "none",
        food: "true",
        sort: "-price",
      }),
    ).toBe("packout, Paint, No UPC +1 ↓price");
  });
});

describe("paramToSort / sortToParam", () => {
  it("round-trips, and rejects the empty cases", () => {
    expect(paramToSort("name,-createdAt")).toEqual([
      { id: "name", desc: false },
      { id: "createdAt", desc: true },
    ]);
    expect(sortToParam([{ id: "name", desc: true }])).toBe("-name");
    expect(sortToParam([])).toBeUndefined();
    expect(paramToSort("")).toBeUndefined();
    expect(paramToSort(undefined)).toBeUndefined();
    expect(paramToSort(42)).toBeUndefined();
  });
});

describe("compileFilterCodec", () => {
  const specs = [
    { columnId: "name", kind: "text" },
    { columnId: "trade", kind: "multiselect" },
    { columnId: "scope", kind: "text", urlKey: "in", urlOnly: true },
  ] as const satisfies readonly FilterSpecCore[];

  it("owns exactly the column-backed keys and encodes only those", () => {
    const codec = compileFilterCodec(specs);
    expect(codec.columnKeys).toEqual(["name", "trade"]);
    expect(codec.urlOnlyKeys).toEqual(["in"]);
    expect(
      codec.encode((columnId) =>
        columnId === "trade" ? ["drywall", "electrical"] : undefined,
      ),
    ).toEqual({ name: undefined, trade: "drywall,electrical" });
  });

  it("decodes each side from the same search", () => {
    const codec = compileFilterCodec(specs);
    const search = { name: "saw", trade: "drywall,electrical", in: "LOC-4K7M" };
    expect(codec.decodeColumns(search)).toEqual([
      { id: "name", value: "saw" },
      { id: "trade", value: ["drywall", "electrical"] },
    ]);
    expect(codec.decodeUrlOnly(search)).toEqual([
      { id: "scope", value: "LOC-4K7M" },
    ]);
  });
});
