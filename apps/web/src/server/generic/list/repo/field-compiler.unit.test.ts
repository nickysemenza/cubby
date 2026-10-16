import { and, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import type { Database } from "~/server/db";
import { inventoryEntry, location, purchase, run } from "~/server/db/schema";
import { renderWhereSql } from "~/server/testing/mock-db";

import { listPrepare } from "./field-compiler";
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
        valuationStatus: valuations.predicate(() => sql`true`),
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
        valuationStatus: valuations.predicate(() => sql`true`),
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

  it("keeps a part's declared NULL placement and fixed direction", () => {
    const scaffold = listScaffold("purchase", purchase, {
      derived: {
        reconciliationGap: [
          { sql: sql`gap`, nulls: "high" },
          { sql: sql`received`, direction: "desc" },
        ],
        vendorId: sql`0`,
        expenseCount: sql`0`,
        expenseTotal: sql`0`,
        documentCount: sql`0`,
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
        valuationStatus: valuations.predicate(() => sql`true`),
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
        expenseCount: sql`0`,
        expenseTotal: sql`0`,
        documentCount: sql`0`,
      },
    });
    const clauses = scaffold.orderBy([
      { orderBy: "reconciliationGap", direction: "desc" },
    ]);
    expect(renderWhereSql(clauses[0])).toBe("declared_gap desc nulls last");
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
    // A hierarchy without a toggle-bearing filter leaves own filters alone.
    expect(
      whereSql(
        listScaffold("location", location, {
          derived: {
            inventoryEntries: sql`0`,
            valuation: listPrepare(async () => null).value(() => sql`0`),
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
        valuationStatus: valuations.predicate(
          (_prepared, { values }) => sql`prepared_status = ${values[0]}`,
        ),
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
    ).toContain("prepared_status = $");
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
});
