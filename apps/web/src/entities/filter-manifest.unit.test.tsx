import { entitySchema } from "@cubby/schemas/entity";
import { browserRoutedEntities } from "@cubby/schemas/entity-manifest";
import { testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";

import { getEntityFilters, manifestFilterConfig } from "./filter-manifest";
import {
  buildFiltersFromManifest,
  decodeFilters,
  encodeFilters,
  FILTER_ANY,
  FILTER_NONE,
  filterGetterFromSearch,
  partitionFilterSpecs,
} from "./filters";
import { generatedEntityFilterContractCases } from "./generated/entity-filter-contracts.gen";
import { entitySearch } from "./generated/entity-search.gen";

const VENDOR_ONE = testShortcode("vendor", "VEN-4K7M");
const VENDOR_TWO = testShortcode("vendor", "VEN-9Q2X");
const PRODUCT_ID = testShortcode("product", "PRD-4K7M");
const PURCHASE_ID = testShortcode("purchase", "PUR-4K7M");

describe("manifestFilterConfig", () => {
  it.each([
    ["task", "status"],
    ["task", "trade"],
    ["expense", "trade"],
    ["expense", "costType"],
    ["purchase", "vendor"],
  ] as const)("%s.%s is multiselect", (entity, columnId) => {
    expect(manifestFilterConfig(entity, columnId)?.filterType).toBe(
      "multiselect",
    );
  });

  it.each([
    ["expense", "product"],
    // The cross-entity presence filters. These also pin the exact `columnId`
    // each one hangs on: a spec whose id matches no column renders NOTHING,
    // silently (the bug recorded on `task.dueDate` in the manifest).
    ["product", "expenses"],
    ["product", "food"],
    ["product", "image"],
    ["product", "unitMappingQuality"],
    ["product", "purchaseDate"],
    ["location", "inventoryEntries"],
    ["ingredient", "appearsInRecipes"],
    ["recipe", "meals"],
    ["recipe", "image"],
    ["purchase", "orderId"],
    ["purchase", "statedTotal"],
    ["expense", "future"],
    ["expense", "date"],
    ["expense", "cost"],
    ["expense", "productQuantity"],
    ["purchase", "date"],
  ] as const)("%s.%s stays single-select", (entity, columnId) => {
    expect(manifestFilterConfig(entity, columnId)?.filterType).toBe("select");
  });

  it("carries the options the control renders", () => {
    const config = manifestFilterConfig("expense", "trade");
    expect(config?.options?.some((o) => o.value === "drywall")).toBe(true);
  });

  it("resolves a runtime picklist by key", () => {
    const sentinels = [
      { value: FILTER_ANY, label: "Has project", meta: true },
      { value: FILTER_NONE, label: "(none)", meta: true },
    ];
    const injected = [{ value: "p1", label: "Kitchen" }];
    expect(
      manifestFilterConfig("expense", "project", { project: injected })
        ?.options,
    ).toEqual([...sentinels, ...injected]);
    expect(manifestFilterConfig("expense", "project")?.options).toEqual(
      sentinels,
    );
  });

  it("does not prepend sentinels to a non-nullable multiselect", () => {
    const options = manifestFilterConfig("expense", "trade")?.options;
    expect(options?.some((o) => o.meta)).toBe(false);
  });

  it("keeps Inventory detail cohorts exact and URL-only", () => {
    const filters = getEntityFilters("inventory");

    expect(
      filters.find((filter) => filter.columnId === "productId"),
    ).toMatchObject({
      field: "productIdFilter",
      kind: "id",
      urlOnly: true,
    });
    expect(
      filters.find((filter) => filter.columnId === "locationId"),
    ).toMatchObject({
      field: "locationIdFilter",
      kind: "id",
      urlOnly: true,
    });
    expect(
      filters.find((filter) => filter.columnId === "product"),
    ).toMatchObject({ field: "productNameFilter", kind: "text" });
    expect(
      filters.find((filter) => filter.columnId === "location"),
    ).toMatchObject({ field: "locationNameFilter", kind: "text" });
  });

  it("puts the Product Vendors roster on its related preview column", () => {
    const vendors = [{ value: "VEN-4K7M", label: "Hardware Store" }];
    expect(
      manifestFilterConfig("product", "related:product.vendors", {
        productVendors: vendors,
      }),
    ).toEqual({
      placeholder: "Filter by vendor...",
      filterType: "multiselect",
      options: [
        { value: FILTER_ANY, label: "Has vendor", meta: true },
        { value: FILTER_NONE, label: "(none)", meta: true },
        ...vendors,
      ],
    });
  });

  it("puts the Product Projects roster and presence sentinels on its related column", () => {
    const projects = [{ value: "PRJ-4K7M", label: "Kitchen" }];
    expect(
      manifestFilterConfig("product", "related:product.projects", {
        project: projects,
      }),
    ).toEqual({
      placeholder: "Filter by project...",
      filterType: "multiselect",
      options: [
        { value: FILTER_ANY, label: "Has project", meta: true },
        { value: FILTER_NONE, label: "(none)", meta: true },
        ...projects,
      ],
    });
  });

  it.each([
    ["recipe", "source", "cookbook"],
    ["location", "parent", "parent"],
  ] as const)(
    "%s.%s prepends (none) / Has %s sentinels",
    (entity, columnId, label) => {
      expect(manifestFilterConfig(entity, columnId)?.options).toEqual([
        { value: FILTER_ANY, label: `Has ${label}`, meta: true },
        { value: FILTER_NONE, label: "(none)", meta: true },
      ]);
    },
  );

  it("returns undefined for a column with no declared filter", () => {
    expect(manifestFilterConfig("expense", "updatedBy")).toBeUndefined();
  });

  it("returns undefined for a urlOnly spec even when a column shares its id", () => {
    // `partitionFilterSpecs` keeps a urlOnly spec out of `columnFilters`, so a
    // header control bound to one can neither read its current value nor write
    // a new one — it renders an inert combobox over an empty option list. The
    // usual loud failure (`[Table] Column with id 'x' does not exist`) can't
    // fire here precisely BECAUSE the column exists, which is how the
    // transactions table shipped two dead headers. Every other urlOnly spec
    // escaped only by not colliding with a rendered column's id.
    const [, urlOnly] = partitionFilterSpecs(getEntityFilters("expense"));
    expect(urlOnly.length).toBeGreaterThan(0);
    for (const spec of urlOnly) {
      expect(manifestFilterConfig("expense", spec.columnId)).toBeUndefined();
    }
  });

  it("gives every rendered picklist something to render", () => {
    // The mirror-image defect: a spec that IS column-backed but declares
    // neither `options` nor an `optionsKey` renders the same empty dropdown
    // from the opposite direction. Product's model/UPC/notes presence filters
    // sat that way unnoticed. Text, boolean and range kinds are exempt — they
    // aren't picklists (boolean synthesizes Yes/No, range carries its own
    // static buckets, checked by the schema suite below).
    const pickerKinds = new Set(["select", "multiselect", "presence", "id"]);
    const violations: string[] = [];
    for (const entity of browserRoutedEntities) {
      for (const spec of getEntityFilters(entity)) {
        if (spec.urlOnly || !pickerKinds.has(spec.kind)) continue;
        if (spec.optionsKey || spec.nullable) continue;
        if (!spec.options?.length) {
          violations.push(`${entity}.${spec.columnId}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe("generated filter contracts", () => {
  it("keeps generated descriptor, URL, schema, option, audit, and expander cases exact", () => {
    for (const [entity, contract] of Object.entries(
      generatedEntityFilterContractCases,
    )) {
      const parsedEntity = entitySchema.safeParse(entity);
      if (!parsedEntity.success) throw new Error(`Unknown entity: ${entity}`);
      const specs = getEntityFilters(parsedEntity.data);
      expect(specs.map((spec) => spec.columnId)).toEqual(
        contract.descriptorColumns,
      );
      expect(specs.map((spec) => spec.urlKey ?? spec.columnId)).toEqual(
        contract.urlKeys,
      );
      expect(
        contract.referenceFilters.every(({ columnId, entity: target }) => {
          const spec = specs.find(
            (candidate) => candidate.columnId === columnId,
          );
          if (
            spec === undefined ||
            (spec.kind !== "id" && spec.kind !== "idMulti") ||
            spec.brand === undefined
          ) {
            return false;
          }
          const shortcode = testShortcode(
            target,
            `${entity}-${columnId}-filter`,
          );
          const field = spec.field ?? spec.columnId;
          const filters = buildFiltersFromManifest(
            specs,
            filterGetterFromSearch(specs, {
              [spec.urlKey ?? columnId]: shortcode,
            }),
          );
          return (
            spec.brand(shortcode) === shortcode &&
            (spec.kind === "id"
              ? filters[field] === shortcode
              : Array.isArray(filters[field]) &&
                filters[field]?.[0] === shortcode)
          );
        }),
      ).toBe(true);
      expect(new Set(contract.urlKeys).size).toBe(contract.urlKeys.length);
      expect(
        contract.rangeExpanders.every((entry) => {
          const columnId = entry.slice(0, entry.indexOf(":~/"));
          return specs.some(
            (spec) =>
              spec.columnId === columnId &&
              spec.kind === "range" &&
              spec.expand,
          );
        }),
      ).toBe(true);
      if (contract.audit) {
        // oxlint-disable-next-line vitest/no-conditional-expect -- The data-dependent branch determines whether this optional case is applicable.
        expect(specs.map((spec) => spec.columnId)).toEqual(
          // oxlint-disable-next-line vitest/no-conditional-expect -- The data-dependent branch determines whether this optional case is applicable.
          expect.arrayContaining(["createdAt", "updatedAt"]),
        );
      }
    }
  });
});

describe("public entity-reference filters", () => {
  it("parses a planting plant shortcode and never widens invalid URLs", () => {
    const specs = getEntityFilters("planting");
    const build = (plantId: string) =>
      buildFiltersFromManifest(
        specs,
        filterGetterFromSearch(specs, { plantId }),
      );

    expect(build("PLANT-C2YH")).toEqual({ plantId: ["PLANT-C2YH"] });
    expect(build("not-a-plant")).toEqual({
      plantId: ["__unresolvable_entity_filter__"],
    });
  });
});

describe("expense order-id filters", () => {
  type SearchInput = Record<string, string | string[] | undefined>;
  const build = (search: SearchInput) => {
    const specs = getEntityFilters("expense");
    return buildFiltersFromManifest(
      specs,
      filterGetterFromSearch(specs, search),
    );
  };

  it("routes ?order= to the exact orderId field", () => {
    expect(build({ order: "111-1234567-1234567" })).toMatchObject({
      orderId: "111-1234567-1234567",
    });
  });

  it("routes ?orderId= to the presence field", () => {
    expect(build({ orderId: FILTER_NONE })).toMatchObject({
      orderIdPresenceFilter: FILTER_NONE,
    });
  });

  it("stands alone without a vendor to disambiguate it", () => {
    expect(build({ order: "WN63446464" })).toEqual({
      orderId: "WN63446464",
    });
  });

  it("still carries a vendor alongside it as a separate condition", () => {
    expect(build({ order: "WN63446464", vendor: VENDOR_ONE })).toMatchObject({
      orderId: "WN63446464",
      vendorId: [VENDOR_ONE],
    });
  });

  it("keeps the exact scope and the presence worklist independent", () => {
    const built = build({ order: "#11325", orderId: FILTER_ANY });
    expect(built).toMatchObject({
      orderId: "#11325",
      orderIdPresenceFilter: FILTER_ANY,
    });
  });
});

describe("expense vendor filter", () => {
  type SearchInput = Record<string, string | string[] | undefined>;
  const build = (search: SearchInput) => {
    const specs = getEntityFilters("expense");
    return buildFiltersFromManifest(
      specs,
      filterGetterFromSearch(specs, search),
    );
  };

  it("routes ?vendor= to the vendorId field as a set", () => {
    expect(build({ vendor: `${VENDOR_ONE},${VENDOR_TWO}` })).toEqual({
      vendorId: [VENDOR_ONE, VENDOR_TWO],
    });
  });

  it("routes the (none) sentinel to vendorPresenceFilter, ORing with a selection", () => {
    expect(build({ vendor: `${VENDOR_ONE},${FILTER_NONE}` })).toEqual({
      vendorId: [VENDOR_ONE],
      vendorPresenceFilter: "none",
    });
    expect(build({ vendor: FILTER_NONE })).toEqual({
      vendorPresenceFilter: "none",
    });
  });

  it("is a multiselect whose runtime roster resolves under the `vendor` key", () => {
    const injected = [{ value: VENDOR_ONE, label: "Home Depot" }];
    const config = manifestFilterConfig("expense", "vendor", {
      vendor: injected,
    });
    expect(config?.filterType).toBe("multiselect");
    expect(config?.options).toEqual([
      { value: FILTER_ANY, label: "Has purchase", meta: true },
      { value: FILTER_NONE, label: "(none)", meta: true },
      ...injected,
    ]);
  });
});

describe("purchase filters", () => {
  type SearchInput = Record<string, string | string[] | undefined>;
  const build = (search: SearchInput) => {
    const specs = getEntityFilters("purchase");
    return buildFiltersFromManifest(
      specs,
      filterGetterFromSearch(specs, search),
    );
  };

  it("routes broad and display-label searches through separate columns", () => {
    expect(build({ q: "WN63446464" })).toEqual({ search: "WN63446464" });
    expect(build({ label: "pocket hole" })).toEqual({
      displayLabelSearch: "pocket hole",
    });
    expect(manifestFilterConfig("purchase", "displayLabel")).toMatchObject({
      filterType: "text",
      placeholder: "Search display label...",
    });
  });

  it("routes ?vendor= to the vendorId field as a set", () => {
    expect(build({ vendor: VENDOR_ONE })).toEqual({ vendorId: [VENDOR_ONE] });
    expect(build({ vendor: `${VENDOR_ONE},${VENDOR_TWO}` })).toEqual({
      vendorId: [VENDOR_ONE, VENDOR_TWO],
    });
  });

  it("offers no vendor sentinels — Purchase.vendorId is NOT NULL", () => {
    const spec = getEntityFilters("purchase").find(
      (s) => s.columnId === "vendor",
    );
    expect(spec?.nullable).toBeUndefined();
    const injected = [{ value: VENDOR_ONE, label: "Home Depot" }];
    const config = manifestFilterConfig("purchase", "vendor", {
      vendor: injected,
    });
    expect(config?.filterType).toBe("multiselect");
    expect(config?.options).toEqual(injected);
  });

  it("routes ?orderId= and ?statedTotal= to their presence fields", () => {
    expect(build({ orderId: "none", statedTotal: "none" })).toEqual({
      orderIdPresenceFilter: "none",
      statedTotalPresenceFilter: "none",
    });
    expect(manifestFilterConfig("purchase", "orderId")?.options).toEqual([
      { value: "has", label: "Has order id", meta: true },
      { value: "none", label: "(none)", meta: true },
    ]);
  });

  it("routes Expense health, reconciliation, documents, and total presets", () => {
    expect(
      build({
        lines: "unpriced,priced",
        reconciliation: "mismatch,unknown",
        documents: "none",
        lineTotal: "gte200",
      }),
    ).toEqual({
      expenseStatus: ["unpriced", "priced"],
      reconciliation: ["mismatch", "unknown"],
      documentPresenceFilter: "none",
      expenseTotalMin: 200,
    });
  });

  it("passes exact Expense-total bounds through for server coercion", () => {
    expect(build({ lineTotalMin: "-25", lineTotalMax: "500" })).toEqual({
      expenseTotalMin: "-25",
      expenseTotalMax: "500",
    });
  });

  it("expands ?date= into inclusive dateFrom/dateTo bounds", () => {
    const built = build({ date: "30d" });
    expect(built).toMatchObject({
      dateFrom: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      dateTo: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
    expect(build({ date: "nonsense" })).toEqual({});
  });

  it("emits nothing for an unfiltered table", () => {
    expect(build({})).toEqual({});
  });

  it("round-trips a ?vendor= scope through the URL", () => {
    const specs = getEntityFilters("purchase");
    const url = entitySearch.purchase.schema.parse({
      vendor: "VEN-4K7M,VEN-2ABC",
    });

    const decoded = decodeFilters(specs, url);
    expect(decoded).toEqual([
      { id: "vendor", value: ["VEN-4K7M", "VEN-2ABC"] },
    ]);

    const state = new Map(decoded.map((f) => [f.id, f.value]));
    expect(encodeFilters(specs, (columnId) => state.get(columnId))).toEqual({
      q: undefined,
      label: undefined,
      vendor: "VEN-4K7M,VEN-2ABC",
      orderId: undefined,
      date: undefined,
      statedTotal: undefined,
      lines: undefined,
      lineTotal: undefined,
      reconciliation: undefined,
      documents: undefined,
      transactions: undefined,
      dataQuality: undefined,
      dataGaps: undefined,
      lineTotalMin: undefined,
      lineTotalMax: undefined,
    });
  });
});

describe("expense URL-only scopes", () => {
  it("routes the Cost column's preset to either presence or a bound", () => {
    const specs = getEntityFilters("expense");
    expect(
      buildFiltersFromManifest(
        specs,
        filterGetterFromSearch(specs, { cost: "none" }),
      ),
    ).toEqual({ costPresenceFilter: "none" });
    expect(
      buildFiltersFromManifest(
        specs,
        filterGetterFromSearch(specs, { cost: "credits" }),
      ),
    ).toEqual({ costMax: 0 });
  });

  it("passes exact ?costMin=/?costMax= through for the server to coerce", () => {
    const specs = getEntityFilters("expense");
    expect(
      buildFiltersFromManifest(
        specs,
        filterGetterFromSearch(specs, { costMin: "500", costMax: "1000" }),
      ),
    ).toEqual({ costMin: "500", costMax: "1000" });
  });

  it("routes Quantity presets and passes exact bounds through for server coercion", () => {
    const specs = getEntityFilters("expense");
    expect(
      buildFiltersFromManifest(
        specs,
        filterGetterFromSearch(specs, { productQuantity: "exactly1" }),
      ),
    ).toEqual({ productQuantityMin: 1, productQuantityMax: 1 });
    expect(
      buildFiltersFromManifest(
        specs,
        filterGetterFromSearch(specs, {
          productQuantityMin: "2",
          productQuantityMax: "5",
        }),
      ),
    ).toEqual({ productQuantityMin: "2", productQuantityMax: "5" });
  });

  it("still routes ?productId= to the server filter", () => {
    const specs = getEntityFilters("expense");
    expect(
      buildFiltersFromManifest(
        specs,
        filterGetterFromSearch(specs, { productId: PRODUCT_ID }),
      ),
    ).toMatchObject({ productId: PRODUCT_ID });
  });

  it("still routes ?purchaseId= to the server filter", () => {
    const specs = getEntityFilters("expense");
    expect(
      buildFiltersFromManifest(
        specs,
        filterGetterFromSearch(specs, { purchaseId: PURCHASE_ID }),
      ),
    ).toMatchObject({ purchaseId: PURCHASE_ID });
  });

  it("still declares a search field for every URL-only key", () => {
    const fields = entitySearch.expense.schema.shape;
    expect(Object.keys(fields)).toEqual(
      expect.arrayContaining([
        "productId",
        "order",
        "purchaseId",
        "subprojects",
      ]),
    );
  });

  it("routes the subtree deep-link scope to the server filter", () => {
    const specs = getEntityFilters("expense");
    expect(
      buildFiltersFromManifest(
        specs,
        filterGetterFromSearch(specs, { subprojects: "true" }),
      ),
    ).toMatchObject({ includeSubProjects: true });
  });
});
