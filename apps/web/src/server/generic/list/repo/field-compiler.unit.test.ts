import { generatedEntityListFields } from "@cubby/schemas/entity-list-fields";
import { allEntities, entityManifest } from "@cubby/schemas/entity-manifest";
import { and, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import type { Database } from "~/server/db";
import { inventoryEntry, location, purchase, run } from "~/server/db/schema";
import { renderWhereSql } from "~/server/testing/mock-db";

import {
  listPrepare,
  sharedListPrepare,
  ListPreparationScope,
  rowSetSql,
  groupSql,
  ListContext,
} from "./field-compiler";
import { listScaffold } from "./list";

/**
 * One compiled expression per declared list field. Failure modes: a related
 * path joins the outer row instead of correlating, a hierarchy filter stops
 * at direct children or ignores its toggle, a repository value is not the
 * expression its sort orders by, and a request-scoped `prepare` runs when no
 * requested field reads it or runs once per consumer.
 */
describe("list field compiler", () => {
  const db = {} as Database;
  // Inventory's other filter-only fields, which these cases never read.
  const filterOnly = {
    locationRole: sql`false`,
    effectiveOwner: () => sql`true`,
    categoryFeature: () => sql`true`,
  };
  const whereSql = (where: ReturnType<typeof and>) =>
    renderWhereSql(where) ?? "";

  it("compiles a related path ending in a hierarchy to EXISTS over its descendants", () => {
    const valuations = listPrepare(async () => new Map<string, number>());
    const scaffold = listScaffold("inventory", inventoryEntry, {
      derived: {
        valuation: valuations.value(() => sql`0`),
        amount: [sql`unit`, sql`size`],
        ...filterOnly,
        valuationStatus: valuations.value(() => sql`0`),
      },
    });
    const included = whereSql(
      and(...scaffold.filterPredicates({ categoryFilter: ["CAT-2345"] })),
    );
    expect(included).toMatch(/EXISTS \(SELECT 1 FROM "InventoryEntry" lf0/);
    expect(included).toContain('JOIN "ProductCategory" lf2');
    expect(included).toContain("WITH RECURSIVE descendants");
    expect(included).toContain('lf0."id" = "InventoryEntry"."id"');

    const direct = whereSql(
      and(
        ...scaffold.filterPredicates({
          categoryFilter: ["CAT-2345"],
          includeSubProductCategories: false,
        }),
      ),
    );
    expect(direct).toContain('JOIN "ProductCategory" lf2');
    expect(direct).not.toContain("WITH RECURSIVE");
  });

  it("orders a to-one related path by a correlated scalar subquery", () => {
    const valuations = listPrepare(async () => new Map<string, number>());
    const scaffold = listScaffold("inventory", inventoryEntry, {
      derived: {
        valuation: valuations.value(() => sql`0`),
        amount: [sql`unit`, sql`size`],
        ...filterOnly,
        valuationStatus: valuations.value(() => sql`0`),
      },
    });
    const [clause] =
      scaffold.derivedSort({ orderBy: "category", direction: "asc" }) ?? [];
    // The path starts at the outer row's own reference, not a second read
    // of the root by id.
    expect(renderWhereSql(clause)).toMatch(
      /^\(SELECT lf2\."name" FROM "Product" lf1 JOIN "ProductCategory" lf2 .*WHERE \("InventoryEntry"\."productId" = lf1\."id"\) AND lf1\."deletedAt" IS NULL\) asc nulls last$/,
    );
    expect(renderWhereSql(clause)).not.toContain('"InventoryEntry" lf0');
  });

  // Purchase's other declared derived fields, which these sorts never read.
  const purchaseFilterOnly = {
    pricedExpenseTotal: sql`0`,
    expenseStatus: sql`0`,
    hasDocuments: sql`false`,
    financialReconciliation: sql`0`,
    reconciliation: sql`0`,
    effectivePurchaser: sql`null`,
  };

  it("keeps a part's declared NULL placement and fixed direction", () => {
    const scaffold = listScaffold("purchase", purchase, {
      derived: {
        reconciliationGap: [
          { sql: sql`gap`, nulls: "high" },
          { sql: sql`received`, direction: "desc" },
        ],
        vendorId: sql`0`,
        ...purchaseFilterOnly,
      },
    });
    const render = (direction: "asc" | "desc") =>
      scaffold
        .derivedSort({ orderBy: "reconciliationGap", direction })
        ?.map((clause) => renderWhereSql(clause));
    expect(render("desc")).toEqual([
      "gap desc nulls first",
      "received desc nulls last",
    ]);
    expect(render("asc")).toEqual([
      "gap asc nulls last",
      "received desc nulls last",
    ]);
  });

  it("orders a compound derived value part by part", () => {
    const valuations = listPrepare(async () => new Map<string, number>());
    const scaffold = listScaffold("inventory", inventoryEntry, {
      derived: {
        valuation: valuations.value(() => sql`0`),
        amount: [sql`unit`, sql`size`],
        ...filterOnly,
        valuationStatus: valuations.value(() => sql`0`),
      },
    });
    expect(
      scaffold
        .derivedSort({ orderBy: "amount", direction: "desc" })
        ?.map((clause) => renderWhereSql(clause)),
    ).toEqual(["unit desc nulls last", "size desc nulls last"]);
  });

  it("orders a derived value by the SQL its repository passes", () => {
    const scaffold = listScaffold("purchase", purchase, {
      derived: {
        reconciliationGap: sql`declared_gap`,
        vendorId: sql`0`,
        ...purchaseFilterOnly,
      },
    });
    const clauses = scaffold.orderBy([
      { orderBy: "reconciliationGap", direction: "desc" },
    ]);
    expect(renderWhereSql(clauses[0])).toBe("declared_gap desc nulls last");
  });

  it("orders a declared rollup by its compiled, live, correlated aggregate", () => {
    const scaffold = listScaffold("purchase", purchase, {
      derived: {
        reconciliationGap: sql`declared_gap`,
        vendorId: sql`0`,
        ...purchaseFilterOnly,
      },
    });
    const [count] = scaffold.orderBy([
      { orderBy: "expenseCount", direction: "desc" },
    ]);
    expect(renderWhereSql(count)).toBe(
      `(SELECT count(*)::int FROM "Expense" ru1 WHERE (ru1."purchaseId" = "Purchase"."id") AND ru1."deletedAt" IS NULL) desc nulls last`,
    );
    const [total] = scaffold.orderBy([
      { orderBy: "expenseTotal", direction: "asc" },
    ]);
    expect(renderWhereSql(total)).toContain(
      `COALESCE(sum(ru1."cost"::numeric), 0)::double precision`,
    );
  });

  it("expands a stored filter over a hierarchical reference unless its toggle is off", () => {
    const scaffold = listScaffold("run", run);
    expect(whereSql(scaffold.where({ parentRunId: ["RUN-2345"] }))).toContain(
      "WITH RECURSIVE descendants",
    );
    expect(
      whereSql(
        scaffold.where({ parentRunId: ["RUN-2345"], includeSubRuns: false }),
      ),
    ).not.toContain("WITH RECURSIVE");
    // An unset toggle-bearing filter leaves the list unexpanded.
    expect(
      whereSql(
        listScaffold("location", location, {
          derived: {
            inventoryEntries: sql`0`,
            valuation: listPrepare(async () => null).value(() => sql`0`),
            valuationRollup: sql`0`,
            hasInventory: sql`false`,
            hasImage: sql`false`,
            hasChildren: sql`false`,
            hasAiDescription: sql`false`,
          },
        }).where({}),
      ),
    ).not.toContain("WITH RECURSIVE");
  });

  it("prepares derived data only for a requested field, once per request", async () => {
    let loads = 0;
    const valuations = listPrepare(async () => {
      loads += 1;
      return new Map<string, number>();
    });
    const scaffold = listScaffold("inventory", inventoryEntry, {
      derived: {
        valuation: valuations.value(() => sql`prepared_valuation`),
        amount: [sql`unit`, sql`size`],
        ...filterOnly,
        valuationStatus: valuations.value(() => sql`prepared_status`),
      },
    });

    const skipped = await scaffold.context(db, {
      filters: {},
      sorts: [{ orderBy: "createdAt", direction: "desc" }],
      projection: { kind: "base" },
    });
    expect(loads).toBe(0);
    expect(skipped.has(valuations)).toBe(false);
    expect(
      await scaffold.context(db, {
        filters: {},
        sorts: [{ orderBy: "valuation", direction: "asc" }],
        readIntent: "count",
      }),
    ).toBeDefined();
    expect(loads).toBe(0);

    const filters = { valuationStatus: "valued" };
    const context = await scaffold.context(db, {
      filters,
      sorts: [{ orderBy: "valuation", direction: "asc" }],
      projection: { kind: "full" },
    });
    expect(loads).toBe(1);
    expect(
      whereSql(and(...scaffold.filterPredicates(filters, context))),
    ).toContain("prepared_status IN ($");
    expect(
      renderWhereSql(
        scaffold.derivedSort(
          { orderBy: "valuation", direction: "asc" },
          context,
        )?.[0],
      ),
    ).toBe("prepared_valuation asc nulls last");
    expect(loads).toBe(1);
  });

  it("shares only opted-in preparation within one database-bound operation", async () => {
    let sharedLoads = 0;
    const localFilters: unknown[] = [];
    const shared = sharedListPrepare(async () => ++sharedLoads);
    const local = listPrepare(async (_db, filters) => {
      localFilters.push(filters.valuationStatus);
      return 1;
    });
    const scaffold = listScaffold("inventory", inventoryEntry, {
      derived: {
        valuation: shared.value(() => sql`shared_valuation`),
        valuationStatus: local.value(() => sql`local_status`),
        amount: [sql`unit`, sql`size`],
        ...filterOnly,
      },
    });
    const preparation = new ListPreparationScope(db);
    await scaffold.context(db, {
      filters: {},
      readIntent: "count",
      preparation,
    });
    expect(sharedLoads).toBe(0);
    const read = (status: string, scope = preparation) =>
      scaffold.context(db, {
        filters: { valuationStatus: status },
        sorts: [{ orderBy: "valuation", direction: "asc" }],
        projection: { kind: "full" },
        preparation: scope,
      });
    const contexts = await Promise.all([read("valued"), read("unvalued")]);
    expect(sharedLoads).toBe(1);
    expect(contexts.map((context) => context.get(shared))).toEqual([1, 1]);
    expect(localFilters).toEqual(["valued", "unvalued"]);
    await read("valued", new ListPreparationScope(db));
    expect(sharedLoads).toBe(2);
    const failure = sharedListPrepare(async () => {
      throw new Error("Synthetic prepare failure");
    });
    const failures = await Promise.allSettled([
      preparation.load(failure, db, {}),
      preparation.load(failure, db, {}),
    ]);
    expect(failures.map((result) => result.status)).toEqual([
      "rejected",
      "rejected",
    ]);
  });

  // A row set's table, `where` columns and terminals are checked when its
  // SQL renders, not by the generator, which cannot see the schema.
  it("resolves every declared row set's columns and references", () => {
    for (const entity of allEntities)
      for (const field of Object.values(
        generatedEntityListFields[entity].derived,
      )) {
        const table = entityManifest[entity].dbTable;
        if (field.shape !== "rows" || table === null) continue;
        // A repository relation's columns are its own SQL's.
        const storage = Object.entries(
          generatedEntityListFields[entity].rows,
        ).find(([key]) => key === field.rows)?.[1].storage.kind;
        if (storage === "repository") continue;
        const set = rowSetSql(entity, field.rows, table);
        expect(() =>
          renderWhereSql(set.matches(sql`${set.column(field)} IS NULL`)),
        ).not.toThrow();
      }
  });

  // A relation row set's entity field that inherits (task project) filters
  // by its effective value, as a `via` terminal does; a plain field reads
  // its column.
  it("reads a relation row set's inherited field effectively", () => {
    const set = rowSetSql("product", "subjectTasks", "Product");
    const column = (name: string) =>
      renderWhereSql(
        set.column({
          shape: "rows",
          path: `subjectTasks.${name}`,
          rows: "subjectTasks",
          terminal: {
            kind: "column",
            column: name,
            fieldKind: null,
            options: null,
          },
          sort: "",
          group: "",
        }),
      );
    expect(column("status")).toBe('rs1."status"');
    expect(column("projectId")).not.toBe('rs1."projectId"');
  });
});

// Calendar dates must never acquire a timezone shift. UTC wall timestamps
// require the existing household conversion before the calendar bucket.
describe("group dimensions", () => {
  it("infers bounded choices without inferring free text or numbers", () => {
    const keys = generatedEntityListFields.product.grouping.map(
      ({ key }) => key,
    );
    expect(keys).toContain("stockTracked");
    expect(keys).toContain("createdAt");
    expect(keys).not.toContain("name");
    expect(keys).not.toContain("price");
  });
  it("buckets plain dates directly and timestamps in the household calendar", () => {
    const plain = groupSql(
      "purchase",
      { key: "date", bucket: "week" },
      {},
      purchase,
      ListContext.empty,
    );
    const timestamp = groupSql(
      "purchase",
      { key: "createdAt", bucket: "day" },
      {},
      purchase,
      ListContext.empty,
    );
    expect(renderWhereSql(plain.key)).toContain("date_trunc");
    expect(renderWhereSql(plain.key)).not.toContain("AT TIME ZONE");
    expect(renderWhereSql(timestamp.key)).toContain("AT TIME ZONE");
    expect(() =>
      groupSql(
        "purchase",
        { key: "reconciliation", bucket: "day" },
        {},
        purchase,
        ListContext.empty,
      ),
    ).toThrow("does not support day buckets");
  });
});
