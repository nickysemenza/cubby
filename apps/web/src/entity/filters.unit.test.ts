import { splitTypedList } from "@cubby/schemas/filter-sentinel-fields";
import { sourceListFilterChoices } from "@cubby/schemas/source-list";
import {
  workQueueHouseholdInput,
  workQueueList,
  workQueuePageInput,
} from "@cubby/schemas/work-queue";
import { UNRESOLVABLE_ENTITY_FILTER } from "@cubby/shared";
import { describe, expect, it } from "vitest";

import {
  compileFilterCodec,
  buildFiltersFromManifest,
  encodeFilters,
  FILTER_ALL,
  FILTER_ANY,
  FILTER_EXACT,
  FILTER_NONE,
  filterGetterFromColumnFilters,
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
  it("uses declared Work queue reasons, exclusions and the Problem no-value choice", () => {
    const specs = workQueueList.filters;
    const filters = buildFiltersFromManifest(
      specs,
      getter({
        name: "Synthetic queue",
        reason: [
          "product_category",
          "__not__:reconciliation:purchase-unsettled",
        ],
        entity: [FILTER_NONE],
      }),
    );
    expect(workQueueHouseholdInput.parse(filters)).toMatchObject({
      query: "Synthetic queue",
      reason: ["product_category"],
      reasonExclude: ["reconciliation:purchase-unsettled"],
      entityPresence: "none",
    });
    expect(
      encodeFilters(specs, getter({ reason: ["__not__:product_category"] })),
    ).toMatchObject({ reason: undefined, reasonExclude: "product_category" });
    expect(sourceListFilterChoices(workQueueList, "reason")).toContainEqual({
      value: "reconciliation:purchase-unsettled",
      label: "No settlement evidence",
    });
    expect(
      workQueueList.grouping.find((choice) => choice.key === "recordType")
        ?.filter,
    ).toMatchObject({ columnId: "entity", noValue: true });
    expect(
      workQueuePageInput.safeParse({ check: "product_category" }).success,
    ).toBe(false);
    expect(
      workQueuePageInput.parse({
        reason: "finding",
        reasonExclude: "product_category",
      }),
    ).toMatchObject({ reason: "finding", reasonExclude: "product_category" });
    for (const spec of specs.filter((spec) => spec.kind === "multiselect"))
      expect(spec.exclude).toEqual({
        field: `${spec.columnId}Exclude`,
      });
  });
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
    const specs: FilterSpecCore[] = [
      { columnId: "trade", kind: "multiselect" },
    ];
    // A former single select: one value from a URL or saved view reads as a
    // one-element any-of list.
    expect(
      buildFiltersFromManifest(specs, getter({ trade: "drywall" })),
    ).toEqual({ trade: ["drywall"] });
  });

  it("treats an empty string as unset, not as a filter on ''", () => {
    const specs: FilterSpecCore[] = [
      { columnId: "trade", kind: "multiselect" },
    ];
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
        kind: "idMulti",
        brand: (v) => `branded:${v}`,
      },
    ];
    expect(
      buildFiltersFromManifest(specs, getter({ project: "proj_1" })),
    ).toEqual({ projectId: ["branded:proj_1"] });
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

  // Product tasks: the Tasks column's "Has open task" preset and the status
  // column both write `taskStatusFilter`; Open with Done means either.
  it("unions an any-of list two filters write", () => {
    const specs: FilterSpecCore[] = [
      {
        columnId: "taskStatus",
        field: "taskStatusFilter",
        kind: "multiselect",
      },
      {
        columnId: "tasks",
        kind: "range",
        expand: (v) =>
          v === "open" ? { taskStatusFilter: ["not_started", "blocked"] } : {},
      },
    ];
    expect(
      buildFiltersFromManifest(
        specs,
        getter({ taskStatus: ["done"], tasks: "open" }),
      ),
    ).toEqual({ taskStatusFilter: ["done", "not_started", "blocked"] });
  });

  it("sets a date range's bounds from a from..to value, keeping tokens for the server", () => {
    const specs: FilterSpecCore[] = [
      {
        columnId: "dueDate",
        kind: "range",
        range: { from: "dueFrom", to: "dueTo" },
        expand: (v) => (v === "none" ? { duePresenceFilter: "none" } : {}),
      },
    ];
    const build = (dueDate: string) =>
      buildFiltersFromManifest(specs, getter({ dueDate }));
    expect(build("..@today-1d")).toEqual({ dueTo: "@today-1d" });
    expect(build("2026-01-01..@today")).toEqual({
      dueFrom: "2026-01-01",
      dueTo: "@today",
    });
    expect(build("none")).toEqual({ duePresenceFilter: "none" });
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

  describe("mode tokens", () => {
    const specs: FilterSpecCore[] = [
      {
        columnId: "tags",
        field: "tagFilters",
        kind: "multiselect",
        match: { field: "tagsMatch" },
      },
      {
        columnId: "parent",
        field: "parentId",
        kind: "idMulti",
        subtree: "includeSubCategories",
      },
      {
        columnId: "owner",
        kind: "idMulti",
        currentMember: true,
        brand: (value) => `branded:${value}`,
      },
    ];

    it("sends Match all only beside picked values", () => {
      expect(
        buildFiltersFromManifest(
          specs,
          getter({ tags: ["winter", "wool", FILTER_ALL] }),
        ),
      ).toEqual({ tagFilters: ["winter", "wool"], tagsMatch: "all" });
      expect(
        buildFiltersFromManifest(specs, getter({ tags: [FILTER_ALL] })),
      ).toEqual({});
    });

    it("sends an Include sub-… toggle only when it is off", () => {
      expect(
        buildFiltersFromManifest(specs, getter({ parent: ["SCAT-4K7M"] })),
      ).toEqual({ parentId: ["SCAT-4K7M"] });
      expect(
        buildFiltersFromManifest(
          specs,
          getter({ parent: ["SCAT-4K7M", FILTER_EXACT] }),
        ),
      ).toEqual({ parentId: ["SCAT-4K7M"], includeSubCategories: false });
    });

    it("keeps @me unbranded only where the descriptor declares it", () => {
      expect(
        buildFiltersFromManifest(specs, getter({ owner: ["@me", "LP-4K7M"] })),
      ).toEqual({ owner: ["@me", "branded:LP-4K7M"] });
      expect(
        buildFiltersFromManifest(specs, getter({ parent: ["@me"] })),
      ).toEqual({ parentId: ["@me"] });
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
    expect(isMultiFilterKind("text")).toBe(false);
    expect(isMultiFilterKind("range")).toBe(false);
  });
});

describe("nullableSentinelOptions", () => {
  it("returns Any value and No value, both flagged as meta options", () => {
    expect(nullableSentinelOptions()).toEqual([
      { value: FILTER_ANY, label: "Any value", meta: true },
      { value: FILTER_NONE, label: "No value", meta: true },
    ]);
  });
});

describe("multiSelectFilterFn", () => {
  type EntityReference = {
    id?: string | null;
    name?: string | null;
  };
  type TestCellValue = string | null | undefined | EntityReference;
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

  it("reads a range's bounds, naming a relative bound from today", () => {
    expect(summarize({ purchaseDate: "..@today-1d" })).toBe(
      "on or before today − 1 day",
    );
    expect(summarize({ purchaseDate: "@today-30d..2026-06-01" })).toBe(
      "today − 30 days to 2026-06-01",
    );
  });

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
      "Power Tools or Fasteners",
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

describe("value lists in the URL", () => {
  const specs = [
    { columnId: "tags", field: "tagFilters", kind: "multiselect" },
  ] as const satisfies readonly FilterSpecCore[];

  it("keeps a picked value containing a comma whole through URL and reload", () => {
    // The tag `quick, easy` once reached the server as two tags.
    const codec = compileFilterCodec(specs);
    const picked = ["quick, easy", "dinner"];
    const url = codec.encode((columnId) =>
      columnId === "tags" ? picked : undefined,
    );
    const reloaded = codec.decode(url);
    expect(reloaded).toEqual([{ id: "tags", value: picked }]);
    expect(
      buildFiltersFromManifest(specs, filterGetterFromColumnFilters(reloaded)),
    ).toEqual({ tagFilters: picked });
    expect(buildFiltersFromManifest(specs, () => picked)).toEqual({
      tagFilters: picked,
    });
  });

  it("still splits an unescaped link and typed entry on every comma", () => {
    expect(compileFilterCodec(specs).decode({ tags: "a, b" })).toEqual([
      { id: "tags", value: ["a", "b"] },
    ]);
    expect(splitTypedList("ext-a, ext-b,")).toEqual(["ext-a", "ext-b"]);
  });

  it("keeps a backslash literal unless it escapes a comma or backslash", () => {
    // A bookmark from before escaping (`?tags=path%5Calpha`) once decoded to
    // `pathalpha`, and URL sync rewrote it.
    const codec = compileFilterCodec(specs);
    expect(codec.decode({ tags: "path\\alpha,trailing\\" })).toEqual([
      { id: "tags", value: ["path\\alpha", "trailing\\"] },
    ]);
    const picked = ["path\\alpha", "a\\,b"];
    const url = codec.encode((columnId) =>
      columnId === "tags" ? picked : undefined,
    );
    expect(codec.decode(url)).toEqual([{ id: "tags", value: picked }]);
  });
});

describe("filter aliases", () => {
  const specs = [
    { columnId: "parentTaskId", kind: "idMulti" },
    {
      columnId: "relatedParentTaskId",
      urlKey: "parentTask",
      field: "parentTaskId",
      kind: "idMulti",
      aliasOf: "parentTaskId",
    },
  ] as const satisfies readonly FilterSpecCore[];

  it("decodes an alias into its canonical state and writes the canonical key", () => {
    const codec = compileFilterCodec(specs);
    expect(codec.decode({ parentTask: "TSK-AAAA" })).toEqual([
      { id: "parentTaskId", value: ["TSK-AAAA"] },
    ]);
    expect(
      codec.encode((columnId) =>
        columnId === "parentTaskId" ? ["TSK-BBBB"] : undefined,
      ),
    ).toEqual({ parentTaskId: "TSK-BBBB", parentTask: undefined });
    expect(
      buildFiltersFromManifest(specs, (columnId) =>
        columnId === "parentTaskId" ? ["TSK-BBBB"] : ["TSK-AAAA"],
      ),
    ).toEqual({ parentTaskId: ["TSK-BBBB"] });
  });
});

describe("compileFilterCodec", () => {
  it("folds an Include sub-… toggle's URL key into its filter's state", () => {
    const codec = compileFilterCodec([
      { columnId: "parent", kind: "idMulti", subtree: "includeSubCategories" },
      { columnId: "includeSubCategories", kind: "boolean" },
    ]);
    expect(codec.keys).toEqual(["parent", "includeSubCategories"]);
    const search = { parent: "SCAT-4K7M", includeSubCategories: "false" };
    expect(codec.decode(search)).toEqual([
      { id: "parent", value: ["SCAT-4K7M", FILTER_EXACT] },
    ]);
    expect(
      codec.encode((columnId) =>
        columnId === "parent" ? ["SCAT-4K7M", FILTER_EXACT] : undefined,
      ),
    ).toEqual({ parent: "SCAT-4K7M", includeSubCategories: "false" });
  });

  it("keeps a folded toggle when its standalone descriptor is also encoded", () => {
    // Link builders encode the full descriptor list, companion included.
    expect(
      encodeFilters(
        [
          {
            columnId: "parent",
            kind: "idMulti",
            subtree: "includeSubCategories",
          },
          { columnId: "includeSubCategories", kind: "boolean" },
        ],
        (columnId) =>
          columnId === "parent" ? ["SCAT-4K7M", FILTER_EXACT] : undefined,
      ),
    ).toEqual({ parent: "SCAT-4K7M", includeSubCategories: "false" });
  });

  const specs = [
    { columnId: "name", kind: "text" },
    { columnId: "trade", kind: "multiselect" },
    { columnId: "scope", kind: "text", urlKey: "in" },
  ] as const satisfies readonly FilterSpecCore[];

  it("round-trips every spec through one key set, urlKey included", () => {
    const codec = compileFilterCodec(specs);
    expect(codec.keys).toEqual(["name", "trade", "in"]);
    const search = { name: "saw", trade: "drywall,electrical", in: "LOC-4K7M" };
    const decoded = codec.decode(search);
    expect(decoded).toEqual([
      { id: "name", value: "saw" },
      { id: "trade", value: ["drywall", "electrical"] },
      { id: "scope", value: "LOC-4K7M" },
    ]);
    expect(codec.encode(filterGetterFromColumnFilters(decoded))).toEqual(
      search,
    );
  });
});
