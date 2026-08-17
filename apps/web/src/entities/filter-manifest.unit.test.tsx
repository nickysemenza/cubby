import type { Entity } from "@cubby/schemas/entity";
import { entitySchema } from "@cubby/schemas/entity";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { FilterSpec } from "./filter-manifest";
import {
  entityFilterFieldMaps,
  entityFilterSearchFields,
  getEntityFilters,
  manifestFilterConfig,
} from "./filter-manifest";
import {
  buildFiltersFromManifest,
  decodeFilters,
  encodeFilters,
  FILTER_ANY,
  FILTER_NONE,
  filterGetterFromSearch,
  partitionFilterSpecs,
} from "./filters";

/**
 * `manifestFilterConfig` is what tables that bypass `useStandardColumns` (the
 * embedded project-detail ones, via their column factories in
 * `app/projects/shared.tsx`) call to get the same control the index pages use.
 * These pin the pairs those factories look up, so the two surfaces can't
 * silently diverge back to single-select.
 */
describe("manifestFilterConfig", () => {
  // Each route spreads `entityFilterSearchFields` into its `validateSearch`, so
  // a key the manifest declares but this record omits means the table writes
  // the filter and the router strips it before anything reads it back. Pinned
  // here for EVERY entity, which is why no entity keeps its own hand-written
  // copy of the list.
  it("keeps the eager route search keys aligned with the full UI manifest", () => {
    for (const entity of entitySchema.options) {
      expect(Object.keys(entityFilterSearchFields(entity))).toEqual(
        getEntityFilters(entity).map((spec) => spec.urlKey ?? spec.columnId),
      );
    }
  });

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
    // Complements — selecting both would mean "no filter".
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
    // A boolean, and a set of mutually exclusive windows.
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
    // `expense.project` is a `nullable` spec, so its two sentinels
    // ("Has project" / "(none)") always lead the resolved options.
    const sentinels = [
      { value: FILTER_ANY, label: "Has project", meta: true },
      { value: FILTER_NONE, label: "(none)", meta: true },
    ];
    const injected = [{ value: "p1", label: "Kitchen" }];
    expect(
      manifestFilterConfig("expense", "project", { project: injected })
        ?.options,
    ).toEqual([...sentinels, ...injected]);
    // Absent injection still yields the sentinels, not the spec's static
    // options — proves it doesn't fall back to `spec.options`.
    expect(manifestFilterConfig("expense", "project")?.options).toEqual(
      sentinels,
    );
  });

  it("does not prepend sentinels to a non-nullable multiselect", () => {
    const options = manifestFilterConfig("expense", "trade")?.options;
    expect(options?.some((o) => o.meta)).toBe(false);
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
      // Same shape as `expense.project` above: the two sentinels always lead,
      // regardless of whether the runtime picklist (cookbook roster,
      // sibling locations) has been injected.
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
    for (const entity of entitySchema.options) {
      for (const spec of getEntityFilters(entity)) {
        if (spec.urlOnly || !pickerKinds.has(spec.kind)) continue;
        // A nullable spec always has the two sentinels, so it is never empty.
        if (spec.optionsKey || spec.nullable) continue;
        if (!spec.options?.length) {
          violations.push(`${entity}.${spec.columnId}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe("task subject-product filters", () => {
  const build = (search: Record<string, unknown>) => {
    const specs = getEntityFilters("task");
    return buildFiltersFromManifest(
      specs,
      filterGetterFromSearch(specs, search),
    );
  };

  it("routes an exact ?productId= scope to subjectProductId", () => {
    expect(
      build({ productId: "11111111-1111-4111-8111-111111111111" }),
    ).toEqual({
      subjectProductId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("combines the visible exact-product picker with its presence sentinels", () => {
    expect(build({ subjectProduct: FILTER_NONE })).toEqual({
      subjectProductPresenceFilter: "none",
    });
    expect(
      build({
        productId: "11111111-1111-4111-8111-111111111111",
        subjectProduct: FILTER_ANY,
      }),
    ).toEqual({
      subjectProductId: "11111111-1111-4111-8111-111111111111",
      subjectProductPresenceFilter: "has",
    });
  });

  it("declares both URL keys so the router does not strip either state", () => {
    expect(Object.keys(entityFilterSearchFields("task"))).toEqual(
      expect.arrayContaining(["productId", "subjectProduct"]),
    );
  });
});

/**
 * Locks the naming convention `buildFiltersFromManifest` depends on: a
 * `nullable.field` / a `presence` spec's server field must end in
 * `PresenceFilter`, or the sentinel-routing logic in `./filters` silently
 * writes to the wrong key. Loops the manifest's own entries so a newly added
 * spec is covered automatically, with no per-entity list to keep in sync.
 */
describe("manifest naming invariant", () => {
  it("every nullable.field and presence field ends in PresenceFilter", () => {
    const violations: string[] = [];
    for (const entity of entitySchema.options) {
      for (const spec of getEntityFilters(entity)) {
        if (spec.nullable && !spec.nullable.field.endsWith("PresenceFilter")) {
          violations.push(
            `${entity}.${spec.columnId}: nullable.field "${spec.nullable.field}"`,
          );
        }
        if (spec.kind === "presence") {
          const field = spec.field ?? spec.columnId;
          if (!field.endsWith("PresenceFilter")) {
            violations.push(`${entity}.${spec.columnId}: field "${field}"`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

/**
 * `decodeFilters` / `encodeFilters` / `buildFiltersFromManifest` all key off
 * `columnId` and `urlKey ?? columnId`, and each reads ONE slot per key. Two
 * specs colliding on either would silently share a filter slot — the reason
 * expense's exact order-id filter is `orderIdExact` + `?order=` rather than a
 * second spec on `orderId` (which the presence control already owns).
 */
describe("manifest key uniqueness", () => {
  it("no two specs in an entity share a columnId or a URL key", () => {
    const violations: string[] = [];
    for (const entity of entitySchema.options) {
      const seenColumns = new Set<string>();
      const seenUrlKeys = new Set<string>();
      for (const spec of getEntityFilters(entity)) {
        const urlKey = spec.urlKey ?? spec.columnId;
        if (seenColumns.has(spec.columnId)) {
          violations.push(`${entity}: duplicate columnId "${spec.columnId}"`);
        }
        if (seenUrlKeys.has(urlKey)) {
          violations.push(`${entity}: duplicate url key "${urlKey}"`);
        }
        seenColumns.add(spec.columnId);
        seenUrlKeys.add(urlKey);
      }
    }
    expect(violations).toEqual([]);
  });
});

/**
 * The two order-id filters are independent: `?order=` is the exact "rest of
 * this Purchase" scope, `?orderId=` is the has/none reconciliation worklist. They
 * must be able to coexist in one URL and land on different server fields.
 */
describe("expense order-id filters", () => {
  const build = (search: Record<string, unknown>) => {
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
    // It used to be a rule that `?order=` always rode with a `?vendor=`, since
    // the group key was two loose string columns on the ledger row. The order id
    // now resolves through `purchaseId` against a partial-unique
    // `(vendorId, orderId)`, so a short id is unambiguous on its own — and the
    // Purchase section links to the Purchase itself rather than to this scope.
    expect(build({ order: "WN63446464" })).toEqual({
      orderId: "WN63446464",
    });
  });

  it("still carries a vendor alongside it as a separate condition", () => {
    // Nothing emits this pair any more, but the two keys must stay independent
    // server-side conditions rather than collapsing into one.
    expect(build({ order: "WN63446464", vendor: "vendor-1" })).toMatchObject({
      orderId: "WN63446464",
      vendorId: ["vendor-1"],
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

/**
 * The Vendor filter is id-based now (`Vendor` is a real roster), so it must land
 * on `vendorId` — a name in the `?vendor=` slot is branded as an id and matched
 * as one, never re-resolved. Its `(none)` sentinel still routes to
 * `vendorPresenceFilter`, which server-side means "no Purchase attached".
 */
describe("expense vendor filter", () => {
  const build = (search: Record<string, unknown>) => {
    const specs = getEntityFilters("expense");
    return buildFiltersFromManifest(
      specs,
      filterGetterFromSearch(specs, search),
    );
  };

  it("routes ?vendor= to the vendorId field as a set", () => {
    expect(build({ vendor: "vendor-1,vendor-2" })).toEqual({
      vendorId: ["vendor-1", "vendor-2"],
    });
  });

  it("routes the (none) sentinel to vendorPresenceFilter, ORing with a selection", () => {
    expect(build({ vendor: `vendor-1,${FILTER_NONE}` })).toEqual({
      vendorId: ["vendor-1"],
      vendorPresenceFilter: "none",
    });
    // The sentinel alone is the no-Purchase worklist — no `vendorId` key at all.
    expect(build({ vendor: FILTER_NONE })).toEqual({
      vendorPresenceFilter: "none",
    });
  });

  it("is a multiselect whose runtime roster resolves under the `vendor` key", () => {
    // `optionsKey` stayed `vendor` across the id switch, so the page's existing
    // `filterOptions` wiring keeps feeding it.
    const injected = [{ value: "vendor-1", label: "Home Depot" }];
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

/**
 * The vendor roster's single filter — the whole of `vendorFiltersSchema`. It used
 * to be hand-written on the page (a `filters` fallback plus a `buildFilters`
 * callback), which is why a filtered roster wasn't bookmarkable: `useTableState`
 * only URL-encodes manifest specs. These pin the wiring that replaced it.
 */
describe("vendor filters", () => {
  const build = (search: Record<string, unknown>) => {
    const specs = getEntityFilters("vendor");
    return buildFiltersFromManifest(
      specs,
      filterGetterFromSearch(specs, search),
    );
  };

  it("routes ?q= to the search field", () => {
    // `?q=`, not `?name=` — the money family's search key (the ledger and the
    // purchases table use the same one), over a server-side name substring match.
    expect(build({ q: "home depot" })).toEqual({ search: "home depot" });
  });

  it("emits nothing for an unfiltered roster", () => {
    // An absent key means "no constraint" — `vendorFiltersSchema` has no
    // defaults, so an empty object must stay empty.
    expect(build({})).toEqual({});
  });

  it("declares the roster, rollup, recency, relationship, and audit filters", () => {
    const [columnBacked, urlOnly] = partitionFilterSpecs(
      getEntityFilters("vendor"),
    );
    expect(columnBacked.map((spec) => spec.columnId)).toEqual([
      "name",
      "purchaseCount",
      "spend",
      "latestPurchaseDate",
      "related:vendor.expenses",
      "related:vendor.purchases",
      "related:vendor.products",
      "related:vendor.projects",
      "related:vendor.transactions",
      "createdAt",
      "updatedAt",
    ]);
    expect(urlOnly.map((spec) => spec.columnId)).toEqual([
      "expenseId",
      "expensePresenceFilter",
      "purchaseId",
      "purchasePresenceFilter",
      "productId",
      "productPresenceFilter",
      "projectId",
      "projectPresenceFilter",
      "financialTransactionId",
      "financialTransactionPresenceFilter",
    ]);
  });

  it("gives the name column a text control", () => {
    expect(manifestFilterConfig("vendor", "name")).toEqual({
      placeholder: "Search vendors...",
      filterType: "text",
      options: [],
    });
  });
});

/**
 * The Purchases table's worklist filters. These used to be a
 * LOCAL manifest in `app/purchases/purchase-filters.ts` (specs + header controls
 * + a hand-written `buildFilters` + a hand-rolled search-fields Record), because
 * this file was off-limits to the agent that built the page. They pin the wiring
 * that replaced it.
 */
describe("purchase filters", () => {
  const build = (search: Record<string, unknown>) => {
    const specs = getEntityFilters("purchase");
    return buildFiltersFromManifest(
      specs,
      filterGetterFromSearch(specs, search),
    );
  };

  it("routes broad and display-label searches through separate columns", () => {
    // The search hangs on `purchase` (the Purchase name column — a bespoke accessor
    // over purchase identity, since `standardColumns` is `[]`), not on `orderId`,
    // whose control is the presence worklist. The dedicated label filter can
    // narrow to human context without changing the established broad `?q=`.
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
    // A multi kind always holds an array, even for one value — mixing the two
    // shapes is what splits the React Query cache (see `many` in ./filters).
    expect(build({ vendor: "vendor-1" })).toEqual({ vendorId: ["vendor-1"] });
    expect(build({ vendor: "vendor-1,vendor-2" })).toEqual({
      vendorId: ["vendor-1", "vendor-2"],
    });
  });

  it("offers no vendor sentinels — Purchase.vendorId is NOT NULL", () => {
    // Unlike expense's vendor filter, there's no "(none)" cohort to filter for,
    // so the spec carries no `nullable` and the control has no sentinel options
    // beyond the injected roster.
    const spec = getEntityFilters("purchase").find(
      (s) => s.columnId === "vendor",
    );
    expect(spec?.nullable).toBeUndefined();
    const injected = [{ value: "vendor-1", label: "Home Depot" }];
    const config = manifestFilterConfig("purchase", "vendor", {
      vendor: injected,
    });
    expect(config?.filterType).toBe("multiselect");
    expect(config?.options).toEqual(injected);
  });

  it("routes ?orderId= and ?statedTotal= to their presence fields", () => {
    // Both are reconciliation worklists: Purchases the Vendor issued no order id
    // for, and Purchases with no paperwork total recorded yet.
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
    // Same presets and expander as the ledger's date filter, so one `?date=30d`
    // means the same window on both money tables.
    const built = build({ date: "30d" });
    expect(built).toMatchObject({
      dateFrom: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      dateTo: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
    // An unknown preset resolves to no bound rather than a broken one.
    expect(build({ date: "nonsense" })).toEqual({});
  });

  it("emits nothing for an unfiltered table", () => {
    // An absent key means "no constraint" — `purchaseFiltersSchema` has no
    // defaults, so an empty object must stay empty.
    expect(build({})).toEqual({});
  });

  it("declares every visible worklist filter plus exact URL-only bounds", () => {
    const [columnBacked, urlOnly] = partitionFilterSpecs(
      getEntityFilters("purchase"),
    );
    expect(columnBacked.map((spec) => spec.columnId)).toEqual([
      "purchase",
      "displayLabel",
      "vendor",
      "orderId",
      "date",
      "statedTotal",
      "expenseCount",
      "expenseTotal",
      "reconciliation",
      "documentCount",
      "transactionCount",
      "dataQuality",
      "dataGaps",
      "related:purchase.expenses",
      "related:purchase.transactions",
      "related:purchase.products",
      "related:purchase.projects",
      "createdAt",
      "updatedAt",
    ]);
    expect(urlOnly.map((spec) => spec.columnId)).toEqual([
      "expenseTotalMin",
      "expenseTotalMax",
      "expenseId",
      "expensePresenceFilter",
      "financialTransactionId",
      "financialTransactionPresenceFilter",
      "productId",
      "productPresenceFilter",
      "projectId",
      "projectPresenceFilter",
    ]);
  });

  it("round-trips a ?vendor= scope through the URL", () => {
    // The point of the manifest entry: the param survives the route's schema
    // fragment, decodes into the multi column's ARRAY state, and re-encodes to
    // the same key — so a shared link lands on the same Purchases.
    const specs = getEntityFilters("purchase");
    const url = z
      .object(entityFilterSearchFields("purchase"))
      .parse({ vendor: "vendor-1,vendor-2" });

    const decoded = decodeFilters(specs, url);
    expect(decoded).toEqual([
      { id: "vendor", value: ["vendor-1", "vendor-2"] },
    ]);

    const state = new Map(decoded.map((f) => [f.id, f.value]));
    expect(encodeFilters(specs, (columnId) => state.get(columnId))).toEqual({
      q: undefined,
      label: undefined,
      vendor: "vendor-1,vendor-2",
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

/**
 * The expenses ledger's column-less scopes. `urlOnly` keeps them out of
 * `columnFilters` (a TanStack column has to exist for every entry there, or it
 * logs `[Table] Column with id '<x>' does not exist.` on every render) WITHOUT
 * taking them off the wire — they're still ordinary manifest specs everywhere
 * else.
 *
 * Two reasons a spec lands here: it's a deep-link scope with no control
 * (`productId`, `orderIdExact`, `purchaseId`), or the column it belongs to
 * already spends its single filter slot on something else. `costMin`/`costMax`
 * are the latter — the Cost column renders the preset select, and these carry
 * the exact bounds for MCP and hand-written URLs. `notesSearch`/`urlSearch`
 * have no rendered column at all.
 */
describe("expense URL-only scopes", () => {
  it("marks exactly the specs no column renders", () => {
    const [columnBacked, urlOnly] = partitionFilterSpecs(
      getEntityFilters("expense"),
    );
    expect(urlOnly.map((spec) => spec.columnId)).toEqual([
      "costMin",
      "costMax",
      "productQuantityMin",
      "productQuantityMax",
      "notesSearch",
      "urlSearch",
      "includeSubProjects",
      "productId",
      "orderIdExact",
      "purchaseId",
      "financialTransactionId",
      "financialTransactionPresenceFilter",
    ]);
    expect(columnBacked.some((spec) => spec.urlOnly)).toBe(false);
  });

  it("routes the Cost column's preset to either presence or a bound", () => {
    const specs = getEntityFilters("expense");
    // The sentinels keep their old meaning...
    expect(
      buildFiltersFromManifest(
        specs,
        filterGetterFromSearch(specs, { cost: "none" }),
      ),
    ).toEqual({ costPresenceFilter: "none" });
    // ...and the buckets expand to a signed money bound instead.
    expect(
      buildFiltersFromManifest(
        specs,
        filterGetterFromSearch(specs, { cost: "credits" }),
      ),
    ).toEqual({ costMax: 0 });
  });

  it("passes exact ?costMin=/?costMax= through for the server to coerce", () => {
    const specs = getEntityFilters("expense");
    // Raw strings off the URL — `costMin`/`costMax` are `z.coerce.number()`
    // server-side precisely so this parses rather than being rejected.
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
        filterGetterFromSearch(specs, { productId: "prod-1" }),
      ),
    ).toMatchObject({ productId: "prod-1" });
  });

  it("still routes ?purchaseId= to the server filter", () => {
    const specs = getEntityFilters("expense");
    expect(
      buildFiltersFromManifest(
        specs,
        filterGetterFromSearch(specs, { purchaseId: "purchase-1" }),
      ),
    ).toMatchObject({ purchaseId: "purchase-1" });
  });

  it("still declares a search field for every URL-only key", () => {
    // Without these the route's strict schema strips the params before
    // anything can read them back.
    const fields = entityFilterSearchFields("expense");
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

/**
 * The manifest's own schema fragment must survive what TanStack's `parseSearch`
 * hands it, not just the strings the specs describe. Both shapes below arrive
 * pre-parsed into another type from a hand-typed URL, and used to be dropped.
 */
describe("manifest search fields survive JSON-parsed values", () => {
  const parse = (entity: Entity, search: Record<string, unknown>) =>
    z.object(entityFilterSearchFields(entity)).parse(search);

  // Order ids and vendor names are routinely all digits, so a hand-typed
  // `?q=486242` reaches the schema as a NUMBER. One row per entity whose
  // search key is a realistic place to type one.
  it.each([
    ["expense", "order", 11334],
    ["vendor", "q", 486242],
    ["purchase", "q", 486242],
  ] as const)(
    "%s: keeps an all-digits ?%s= that parsed as a number",
    (entity, key, value) => {
      expect(parse(entity, { [key]: value })).toMatchObject({
        [key]: String(value),
      });
    },
  );

  it("keeps a boolean-shaped filter value that parsed as a boolean", () => {
    // `future`'s option values are the literal strings "true"/"false", so its
    // URL form is indistinguishable from a JSON boolean.
    expect(parse("expense", { future: true })).toMatchObject({
      future: "true",
    });
    expect(parse("expense", { future: false })).toMatchObject({
      future: "false",
    });
  });
});

describe("finance filters", () => {
  const build = (
    entity: "financialAccount" | "financialTransaction",
    search: Record<string, unknown>,
  ) => {
    const specs = getEntityFilters(entity);
    return buildFiltersFromManifest(
      specs,
      filterGetterFromSearch(specs, search),
    );
  };

  it("maps account controls and URL-only evidence fields", () => {
    expect(
      build("financialAccount", {
        q: "visa",
        identity: "credit_card,bank_account",
        provisional: "true",
        aliases: "none",
        last4: "1234",
      }),
    ).toEqual({
      search: "visa",
      identityKind: ["credit_card", "bank_account"],
      provisional: true,
      sourceAliasPresenceFilter: "none",
      last4: "1234",
    });
  });

  it("maps transaction controls and expands posted-date presets", () => {
    const filters = build("financialTransaction", {
      q: "hardware",
      kind: "purchase,refund",
      status: "pending,posted",
      postedDate: "30d",
      amountMin: "-25",
    });
    expect(filters).toMatchObject({
      search: "hardware",
      kind: ["purchase", "refund"],
      status: ["pending", "posted"],
      amountMin: "-25",
      postedDateFrom: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      postedDateTo: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
  });

  it("declares every visible transaction filter plus exact URL-only scopes", () => {
    // The transactions table went a long time with 10 of 16 filters reachable
    // only by hand-editing a URL or over MCP — which is why the statement-drift
    // reconciliation happened in a Python scratchpad instead of in the app.
    // Pinning both halves keeps a new spec from quietly landing on the wrong
    // side of that line, the way vendor/purchase/expense are already pinned.
    const [columnBacked, urlOnly] = partitionFilterSpecs(
      getEntityFilters("financialTransaction"),
    );
    expect(columnBacked.map((spec) => spec.columnId)).toEqual([
      "transaction",
      "kind",
      "status",
      "postedDate",
      "accountId",
      "purchasePresence",
      "source",
      "merchant",
      "amount",
      "related:financialTransaction.vendor",
      "related:financialTransaction.expenses",
      "related:financialTransaction.products",
      "createdAt",
      "updatedAt",
    ]);
    expect(urlOnly.map((spec) => spec.columnId)).toEqual([
      "purchaseId",
      "externalId",
      "amountMin",
      "amountMax",
      "transactionDateFrom",
      "transactionDateTo",
      "postedDateFrom",
      "postedDateTo",
      "vendorId",
      "vendorPresenceFilter",
      "expenseId",
      "expensePresenceFilter",
      "productId",
      "productPresenceFilter",
    ]);
  });
});

/**
 * Every server filter field a spec can emit.
 *
 * A spec emits `field ?? columnId`, plus `nullable.field`, plus — for a `range`
 * kind — whatever its `expand()` returns. Range options are static, so every
 * emitted key is enumerable by calling `expand` for each declared option.
 */
const emittedFields = (spec: FilterSpec): string[] => {
  // A `range` spec emits ONLY what its expander returns — `buildFiltersFromManifest`'s
  // range arm never touches `field`/`columnId`, which is why `expense.date`'s
  // columnId is `date` while the fields it writes are `dateFrom`/`dateTo`.
  if (spec.kind === "range") {
    const expand = spec.expand;
    if (!expand) return [];
    return (spec.options ?? []).flatMap((option) =>
      Object.keys(expand(option.value)),
    );
  }
  const fields = [spec.field ?? spec.columnId];
  if (spec.nullable) fields.push(spec.nullable.field);
  return fields;
};

/**
 * Every field a manifest spec can emit must exist on that entity's
 * `*FilterFields`.
 *
 * `buildFiltersFromManifest` returns a bare `Record<string, unknown>` that
 * callers cast to the entity's filters type, and the server strips keys it
 * doesn't know — so a spec naming a field that doesn't exist produces a filter
 * that silently does nothing. That is the same wrong-but-plausible failure the
 * MCP surface now rejects outright (`strictFilterInput`); the web side can't
 * reject at runtime without breaking the page, so it's pinned here instead.
 */
describe("manifest fields exist on the server schema", () => {
  it("covers every entity that has manifest specs", () => {
    // Guards `entityFilterFieldMaps` against a new entity silently skipping
    // this check — and, since `auditFilterEntities` is derived from that same
    // map, against the audit specs quietly not being composed in for it.
    const withSpecs = entitySchema.options.filter(
      (entity) => getEntityFilters(entity).length > 0,
    );
    expect(withSpecs.sort()).toEqual(
      Object.keys(entityFilterFieldMaps).sort() as Entity[],
    );
  });

  it("emits no field the server does not declare", () => {
    const violations: string[] = [];
    for (const [entity, fields] of Object.entries(entityFilterFieldMaps)) {
      for (const spec of getEntityFilters(entity as Entity)) {
        for (const field of emittedFields(spec)) {
          if (!(field in fields)) {
            violations.push(`${entity}.${spec.columnId} emits "${field}"`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

/**
 * The reverse direction: every field the server declares must be REACHABLE from
 * some manifest spec.
 *
 * The list-filter contract has four directions, and this was the last unguarded
 * one:
 *
 *   manifest → URL keys   `manifestFilterConfig` above
 *   manifest → schema     the describe above (a spec emitting a field nobody declares)
 *   schema   → repo       `server/repo/filter-application.integration.test.ts` (#595)
 *   schema   → manifest   HERE
 *
 * A declared-but-unreachable field is the mirror image of #588: there, the
 * manifest rendered controls the where-builder never read; here, the server
 * accepts a predicate no control can ever send, so the capability exists only
 * for whoever thinks to hand-write the URL. Both are invisible — a filter that
 * does nothing and a filter that can't be reached look identical from the page.
 *
 * "Reachable" is exactly {@link emittedFields}: a spec's `field ?? columnId`,
 * its `nullable.field`, or a key some `range` expander returns. urlOnly specs
 * count — a deep-link scope has no header control but is still reachable from
 * the URL and over MCP.
 */
describe("every server filter field is reachable from the manifest", () => {
  /**
   * Fields no spec can reach, each with the reason it is unreachable ON PURPOSE.
   *
   * Every entry is held to the same hygiene below: one naming a field that no
   * longer exists is stale, and one that has since become reachable must be
   * deleted rather than left to rot. A real missing control belongs in the
   * canonical backlog, not this by-design allowlist.
   */
  const UNREACHABLE_BY_DESIGN: Record<string, string> = {
    // Contextual scope a surrounding page imposes — never user-chosen state, so
    // there is nothing for a header control or a URL key to bind to.
    "expense.projectScope":
      "the /projects page forwards its own visible filter state into the embedded Expense list; an object scope has no URL string form",
    "task.projectScope":
      "same forwarding as expense.projectScope, into the embedded Task list",
    "task.includeSubProjects":
      "set by the project detail page beside its projectId scope. Expense's counterpart IS user-facing (?subprojects=) because the ledger is deep-linked from a project summary and must reconcile against it; the embedded task list is never linked into",
    "project.includeSubProjects":
      "set by the project detail page beside its parentProjectId scope, for the same reason",
    "inventory.locationIdFilter":
      "the surrounding page's scope (location detail's inventory table, the bulk edit/move forms); the visible controls are the name substring filters. routers/inventory.ts resolves it to a uuid before the repo sees it",
    "inventory.productIdFilter":
      "same page-imposed scope and same router-side resolution as inventory.locationIdFilter",

    // List SHAPING rather than a predicate about a row's data — decided by the
    // renderer or by an MCP caller, not by the person reading the table.
    "task.topLevelOnly":
      "tree shaping: the table renders parents with expandable subtasks, so the renderer owns this. Advertised on MCP list_tasks",
    "project.topLevelOnly":
      "same tree shaping for sub-projects. Advertised on MCP list_projects",
    "task.completion":
      "the board and the actionable-task queries pick this scope server-side; the table's visible control is `status`, whose values it summarizes",
    "meal.from":
      "Meals has no filterable list table — the calendar owns its window through ?week= and the shopping list through its own ?from=/?to=. This is the MCP window",
    "meal.to": "the other half of meal.from",

    // A richer control already owns the column's single filter slot, and the
    // unreachable field is the weaker predicate it replaced.
    "product.vendorSearch":
      "the Vendors related column upgraded from the generated substring filter to an exact vendor roster (vendorId, ?related-vendor=)",
    "product.projectSearch":
      "the Projects related column upgraded to an exact project roster (projectId, ?related-project=)",
    "product.purchaseSearch":
      "the Purchases related column upgraded to an exact purchase roster (purchaseId, ?related-purchase=)",
    "purchase.projectSearch":
      "the Projects related column upgraded to an exact project roster (projectId, ?related-project=)",
    "recipe.ingredientSearch":
      "the Ingredients related column upgraded to an exact ingredient roster (ingredientId, ?related-ingredient=)",
    "meal.recipeSearch":
      "the Recipes related column spends its slot on the has/none presence control, which is what the meal/empty-cooked saved view pins — a view can only pin column-backed filters, and the generated presence spec was urlOnly. Substring search over recipe names does not compose with it, and the calendar (not this table) is how meals are usually found",
    "product.taskSearch":
      "the Tasks related column spends its slot on the status/due range control (resolveProductTaskFilter); a substring match over task names does not compose with it",
    "wish.productSearch":
      "the Candidates related column upgraded to an exact candidate-product roster (candidateProductId, ?related-product=), which is the predicate the wish repo actually owns",
    "location.inventoryPresenceFilter":
      "the Inventory control expresses the same predicate through its count bounds — `has` is directItemCountMin: 1, `none` is directItemCountMax: 0",
    "product.expenseCountMax":
      "the Expenses presets are lower bounds plus the two presence sentinels (`none` routes to expensePresenceFilter), so no option can emit an upper bound",
    "purchase.orderId":
      "the visible order-id control is the has/none reconciliation worklist, and ?q= already substring-matches order id. A purchase has its own detail route, so there is no expense-style exact-order-id deep-link scope here",
  };

  const reachableFields = (entity: Entity): Set<string> =>
    new Set(getEntityFilters(entity).flatMap(emittedFields));

  const unreachableFields = (
    entity: Entity,
    fields: Record<string, unknown>,
  ): string[] => {
    const reachable = reachableFields(entity);
    return Object.keys(fields).filter((field) => !reachable.has(field));
  };

  it("every range expander yields at least one field", () => {
    // The reachability set is only as good as this: a `range` spec contributes
    // NOTHING but what `expand()` returns for its own declared option values,
    // and several expanders answer `{}` to a key they don't recognize. One that
    // silently returned `{}` for every option would under-report reachability
    // and quietly turn this whole guard into a formality.
    const silent: string[] = [];
    for (const entity of entitySchema.options) {
      for (const spec of getEntityFilters(entity)) {
        if (spec.kind !== "range") continue;
        if (emittedFields(spec).length === 0) {
          silent.push(`${entity}.${spec.columnId}`);
        }
      }
    }
    expect(silent).toEqual([]);
  });

  it("leaves no declared field without a manifest entry point", () => {
    const violations: string[] = [];
    for (const [entity, fields] of Object.entries(entityFilterFieldMaps)) {
      for (const field of unreachableFields(entity as Entity, fields)) {
        const key = `${entity}.${field}`;
        if (key in UNREACHABLE_BY_DESIGN) continue;
        violations.push(key);
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps the allowlist free of fields that are gone or now reachable", () => {
    const stale = Object.keys(UNREACHABLE_BY_DESIGN).filter((key) => {
      const [entityName, field] = key.split(".");
      const entity = entitySchema.safeParse(entityName);
      if (!entity.success || !field) return true;
      const fields = entityFilterFieldMaps[entity.data];
      if (!fields || !(field in fields)) return true;
      return reachableFields(entity.data).has(field);
    });
    expect(stale).toEqual([]);
  });
});
