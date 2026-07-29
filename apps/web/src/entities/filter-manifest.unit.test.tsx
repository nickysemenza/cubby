import { entitySchema } from "@cubby/schemas/entity";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  entityFilterSearchFields,
  getEntityFilters,
  manifestFilterConfig,
} from "./filter-manifest";
import {
  buildFiltersFromManifest,
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
  it.each([
    ["task", "status"],
    ["task", "trade"],
    ["purchase", "trade"],
    ["purchase", "costType"],
  ] as const)("%s.%s is multiselect", (entity, columnId) => {
    expect(manifestFilterConfig(entity, columnId)?.filterType).toBe(
      "multiselect",
    );
  });

  it.each([
    // Complements — selecting both would mean "no filter".
    ["purchase", "product"],
    ["product", "ingredient"],
    // The cross-entity presence filters. These also pin the exact `columnId`
    // each one hangs on: a spec whose id matches no column renders NOTHING,
    // silently (the bug recorded on `task.dueDate` in the manifest).
    ["product", "purchases"],
    ["product", "food"],
    ["product", "image"],
    ["product", "unitMappingQuality"],
    ["location", "inventoryEntries"],
    ["ingredient", "appearsInRecipes"],
    ["recipe", "meals"],
    ["recipe", "image"],
    // A boolean, and a set of mutually exclusive windows.
    ["purchase", "future"],
    ["purchase", "date"],
  ] as const)("%s.%s stays single-select", (entity, columnId) => {
    expect(manifestFilterConfig(entity, columnId)?.filterType).toBe("select");
  });

  it("carries the options the control renders", () => {
    const config = manifestFilterConfig("purchase", "trade");
    expect(config?.options?.some((o) => o.value === "drywall")).toBe(true);
  });

  it("resolves a runtime picklist by key", () => {
    // `purchase.project` is a `nullable` spec, so its two sentinels
    // ("Has project" / "(none)") always lead the resolved options.
    const sentinels = [
      { value: FILTER_ANY, label: "Has project", meta: true },
      { value: FILTER_NONE, label: "(none)", meta: true },
    ];
    const injected = [{ value: "p1", label: "Kitchen" }];
    expect(
      manifestFilterConfig("purchase", "project", { project: injected })
        ?.options,
    ).toEqual([...sentinels, ...injected]);
    // Absent injection still yields the sentinels, not the spec's static
    // options — proves it doesn't fall back to `spec.options`.
    expect(manifestFilterConfig("purchase", "project")?.options).toEqual(
      sentinels,
    );
  });

  it("does not prepend sentinels to a non-nullable multiselect", () => {
    const options = manifestFilterConfig("purchase", "trade")?.options;
    expect(options?.some((o) => o.meta)).toBe(false);
  });

  it.each([
    ["recipe", "source", "cookbook"],
    ["location", "parent", "parent"],
  ] as const)(
    "%s.%s prepends (none) / Has %s sentinels",
    (entity, columnId, label) => {
      // Same shape as `purchase.project` above: the two sentinels always lead,
      // regardless of whether the runtime picklist (cookbook roster,
      // sibling locations) has been injected.
      expect(manifestFilterConfig(entity, columnId)?.options).toEqual([
        { value: FILTER_ANY, label: `Has ${label}`, meta: true },
        { value: FILTER_NONE, label: "(none)", meta: true },
      ]);
    },
  );

  it("returns undefined for a column with no declared filter", () => {
    // `cost` now HAS a spec (the presence filter added alongside this test) —
    // `createdAt` is a real purchases column that genuinely has none.
    expect(manifestFilterConfig("purchase", "createdAt")).toBeUndefined();
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
 * purchase's exact order-id filter is `orderIdExact` + `?order=` rather than a
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
 * this order" scope, `?orderId=` is the has/none reconciliation worklist. They
 * must be able to coexist in one URL and land on different server fields.
 */
describe("purchase order-id filters", () => {
  const build = (search: Record<string, unknown>) => {
    const specs = getEntityFilters("purchase");
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

  it("carries the vendor its links always pair with, without collapsing them", () => {
    // The link shape the Same Order section emits: an order id is only unique
    // within a vendor, so both keys ride together and must survive as two
    // separate server-side conditions.
    expect(build({ order: "WN63446464", vendor: "Home Depot" })).toMatchObject({
      orderId: "WN63446464",
      vendor: ["Home Depot"],
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
 * The purchases ledger's two column-less scopes. `urlOnly` keeps them out of
 * `columnFilters` (a TanStack column has to exist for every entry there, or it
 * logs `[Table] Column with id '<x>' does not exist.` on every render) WITHOUT
 * taking them off the wire — they're still ordinary manifest specs everywhere
 * else.
 */
describe("purchase URL-only scopes", () => {
  it("marks exactly the specs no column renders", () => {
    const [columnBacked, urlOnly] = partitionFilterSpecs(
      getEntityFilters("purchase"),
    );
    expect(urlOnly.map((spec) => spec.columnId)).toEqual([
      "productId",
      "orderIdExact",
    ]);
    expect(columnBacked.some((spec) => spec.urlOnly)).toBe(false);
  });

  it("still routes ?productId= to the server filter", () => {
    const specs = getEntityFilters("purchase");
    expect(
      buildFiltersFromManifest(
        specs,
        filterGetterFromSearch(specs, { productId: "prod-1" }),
      ),
    ).toMatchObject({ productId: "prod-1" });
  });

  it("still declares a search field for every URL-only key", () => {
    // Without these the route's strict schema strips the params before
    // anything can read them back.
    const fields = entityFilterSearchFields("purchase");
    expect(Object.keys(fields)).toEqual(
      expect.arrayContaining(["productId", "order"]),
    );
  });
});

/**
 * The manifest's own schema fragment must survive what TanStack's `parseSearch`
 * hands it, not just the strings the specs describe. Both of these arrive
 * pre-parsed into another type from a hand-typed URL, and used to be dropped.
 */
describe("manifest search fields survive JSON-parsed values", () => {
  const parse = (search: Record<string, unknown>) =>
    z.object(entityFilterSearchFields("purchase")).parse(search);

  it("keeps an all-digits order id that parsed as a number", () => {
    expect(parse({ order: 11334 })).toMatchObject({ order: "11334" });
  });

  it("keeps a boolean-shaped filter value that parsed as a boolean", () => {
    // `future`'s option values are the literal strings "true"/"false", so its
    // URL form is indistinguishable from a JSON boolean.
    expect(parse({ future: true })).toMatchObject({ future: "true" });
    expect(parse({ future: false })).toMatchObject({ future: "false" });
  });
});
