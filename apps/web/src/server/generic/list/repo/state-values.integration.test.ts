import type { SortParams } from "@cubby/schemas/pagination";
import type { ProductFilters } from "@cubby/schemas/product";
import type { ProjectFilters } from "@cubby/schemas/project";
import {
  type PurchaseFilters,
  purchaseReconciliation,
  RECONCILIATION_TOLERANCE,
} from "@cubby/schemas/purchase";
import { cents } from "@cubby/shared";
import { fromAny } from "@total-typescript/shoehorn";
import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { outer } from "~/server/db/helpers/related";
import {
  financialTransactionAllocation,
  inventoryEntry,
  product,
  purchase,
} from "~/server/db/schema";
import {
  postedRefundTotal,
  vendorExpenseCount,
  vendorExpenseTotal,
  vendorUnpricedExpenseCount,
} from "~/server/domains/financial-transaction/repo/financial-reconciliation";
import { effectiveProductPriceSql } from "~/server/domains/product/repo/pricing";
import {
  expectedQuantityReadSql,
  expectedQuantitySql,
  quantityVarianceSql,
} from "~/server/domains/product/repo/quantity-ledger";
import { projectScaffold } from "~/server/domains/project/repo/lookup";
import {
  loadProjectDateWindows,
  loadProjectTree,
  projectCompletionYear,
} from "~/server/domains/project/repo/subtree";
import { purchaseScaffold } from "~/server/domains/purchase/repo/purchase";
import { setDataException } from "~/server/generic/data-quality/repo/exceptions";
import { gapCondition } from "~/server/generic/data-quality/repo/sql";
import { storedDerivedSql } from "~/server/generic/derived/repo/read";
import { withListGroupBy } from "~/server/generic/list/repo/list";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { drainStoredDerived } from "~/server/testing/background-queue";
import {
  createInventoryFixture,
  createLocationFixture,
  createProductFixture,
  createProductIdentityFixture,
  listInventoryFixture,
  listProductsFixture,
  makeExpenseInput,
  makeLocationInput,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

/**
 * Plan rows 34–37 and 41 (#2609): five filter-only predicates re-declared as
 * row values. Each case runs the retired predicate's SQL and the compiled
 * value filter over one synthetic fixture and compares row ids. Failure
 * modes: a CASE branch order that differs from the predicate's OR (a state
 * that overlaps another), a NULL that a state reads as a value, a set-form
 * filter that disagrees with the scalar its column shows, and a prepared
 * value that sort or group reads without preparing.
 */
describe("state predicates re-declared as values", () => {
  const ctx = withTestDb();
  const page = { pageIndex: 0, pageSize: 100 };
  const sorted = (ids: Iterable<string>) => [...ids].sort();

  it("splits valuation status into disjoint valued, priceable and unpriceable", async () => {
    const shelf = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Valuation parity shelf", type: "shelf" }),
      ctx.actor,
    );
    const seed = async (
      name: string,
      price: number | undefined,
      amount: { value: number; unit: "each" | "g" },
    ) => {
      const sku = await createProductIdentityFixture(
        ctx.db,
        makeProductInput({ name, price }),
        ctx.actor,
      );
      return createInventoryFixture(
        ctx.db,
        { productId: sku.id, locationId: shelf.id, amount },
        ctx.actor,
      );
    };
    const valued = await seed("Parity valued", 10, { value: 2, unit: "each" });
    // A price per each cannot value grams with no unit mapping.
    const priceable = await seed("Parity priceable", 10, {
      value: 100,
      unit: "g",
    });
    const unpriceable = await seed("Parity unpriceable", undefined, {
      value: 1,
      unit: "each",
    });
    await drainStoredDerived(ctx.db);
    const fixture = [valued, priceable, unpriceable].map(({ id }) => id);

    // The retired predicate: `missing` is every NULL valuation, so it
    // overlapped `missing_with_priced_product`.
    const valuation = storedDerivedSql(
      "inventory",
      "valuation",
      inventoryEntry.id,
    );
    const retired = async (condition: SQL) =>
      sorted(
        (
          await getDb(ctx.db)
            .select({ id: inventoryEntry.shortcode })
            .from(inventoryEntry)
            .innerJoin(product, eq(product.id, inventoryEntry.productId))
            .where(and(inArray(inventoryEntry.shortcode, fixture), condition))
        ).map(({ id }) => id),
      );
    const listed = async (
      filters: Parameters<typeof listInventoryFixture>[1],
    ) =>
      sorted(
        (
          await listInventoryFixture(
            ctx.db,
            fromAny({ ...filters, ids: fixture }),
            [],
            page,
          )
        ).data.map(({ id }) => id),
      );

    expect(await listed({ valuationStatus: ["valued"] })).toEqual(
      await retired(sql`${valuation} IS NOT NULL`),
    );
    expect(await listed({ valuationStatus: ["priceable"] })).toEqual(
      await retired(
        sql`${valuation} IS NULL AND ${sql.raw(effectiveProductPriceSql('"Product"'))} IS NOT NULL`,
      ),
    );
    expect(
      await listed({ valuationStatus: ["priceable", "unpriceable"] }),
    ).toEqual(await retired(sql`${valuation} IS NULL`));
    expect(await listed({ valuationStatus: ["valued"] })).toEqual([valued.id]);
    expect(await listed({ valuationStatus: ["priceable"] })).toEqual([
      priceable.id,
    ]);
    expect(await listed({ valuationStatus: ["unpriceable"] })).toEqual([
      unpriceable.id,
    ]);
    // A value negates generically, and groups by its state.
    expect(await listed({ valuationStatusExclude: ["valued"] })).toEqual(
      sorted([priceable.id, unpriceable.id]),
    );
    const grouped = await listInventoryFixture(
      ctx.db,
      withListGroupBy(fromAny({ ids: fixture }), [{ key: "valuationStatus" }]),
      [{ orderBy: "valuationStatus", direction: "asc" }],
      page,
    );
    expect(
      grouped.groups?.map(({ path, count }) => [path.at(-1), count]),
    ).toEqual([
      ["valued", 1],
      ["priceable", 1],
      ["unpriceable", 1],
    ]);
  });

  it("reads quantity variance and expected quantity as the predicates did", async () => {
    const shelf = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Ledger parity shelf", type: "shelf" }),
      ctx.actor,
    );
    const seed = async (
      name: string,
      lines: ReadonlyArray<{ quantity: number | null; cost: number }>,
      stock?: { value: number; unit: "each" | "g" },
    ) => {
      const sku = await createProductFixture(
        ctx.db,
        makeProductInput({ name }),
        ctx.actor,
      );
      for (const [index, line] of lines.entries())
        await createRepoEntity(
          ctx,
          "expense",
          makeExpenseInput({
            name: `${name} line ${index}`,
            productId: sku.id,
            productQuantity: line.quantity,
            cost: line.cost,
          }),
        );
      if (stock !== undefined)
        await createInventoryFixture(
          ctx.db,
          { productId: sku.id, locationId: shelf.id, amount: stock },
          ctx.actor,
        );
      return sku;
    };
    const each = (value: number) => ({ value, unit: "each" }) as const;
    const all = [
      await seed("Parity matched", [{ quantity: 2, cost: 8 }], each(2)),
      await seed("Parity short", [{ quantity: 6, cost: 12 }], each(1)),
      // An unknown quantity makes the history incomparable.
      await seed("Parity uncounted", [{ quantity: null, cost: 5 }], each(1)),
      await seed("Parity unstocked", [{ quantity: 1, cost: 3 }]),
      // Grams are not a count, so on-hand units are unavailable.
      await seed("Parity grams", [{ quantity: 1, cost: 4 }], {
        value: 250,
        unit: "g",
      }),
      await seed("Parity sold off", [
        { quantity: 1, cost: 5 },
        { quantity: -3, cost: -9 },
      ]),
      await seed("Parity untouched", []),
    ];
    await drainStoredDerived(ctx.db);
    const fixture = all.map(({ id }) => id);
    const fixtureIds = all.map(({ entityId }) => entityId);

    const retired = async (condition: SQL | undefined) =>
      sorted(
        (
          await getDb(ctx.db)
            .select({ id: product.shortcode })
            .from(product)
            .where(and(inArray(product.id, fixtureIds), condition))
        ).map(({ id }) => id),
      );
    const listed = async (filters: ProductFilters) =>
      sorted(
        (
          await listProductsFixture(
            ctx.db,
            { ...filters, ids: fixture },
            [],
            page,
          )
        ).data.map(({ id }) => id),
      );

    // Live scalar calculation is the oracle for published filter membership.
    const comparable = sql`(EXISTS (SELECT 1 FROM "InventoryEntry" ie JOIN "Location" l ON l."id" = ie."locationId" AND l."deletedAt" IS NULL WHERE ie."productId" = ${product.id} AND ie."deletedAt" IS NULL)
      OR EXISTS (SELECT 1 FROM "Location" ol WHERE ol."productId" = ${product.id} AND ol."deletedAt" IS NULL))
      AND EXISTS (SELECT 1 FROM "Expense" e WHERE e."productId" = ${product.id} AND e."deletedAt" IS NULL)`;
    const variance = sql.raw(quantityVarianceSql('"Product"'));
    const matched = await retired(sql`${comparable} AND ${variance} = 0`);
    const mismatched = await retired(sql`${comparable} AND ${variance} <> 0`);
    expect(matched).toEqual([all[0]!.id]);
    expect(mismatched).toEqual([all[1]!.id]);
    expect(await listed({ quantityVarianceFilter: ["matched"] })).toEqual(
      matched,
    );
    expect(await listed({ quantityVarianceFilter: ["mismatched"] })).toEqual(
      mismatched,
    );
    // No state outside the comparable gate, so Exclude keeps those rows.
    expect(await listed({ quantityVarianceExclude: ["matched"] })).toEqual(
      sorted(fixture.filter((id) => !matched.includes(id))),
    );

    // The set the filter reads agrees with the scalar the column shows.
    const scalar = await getDb(ctx.db)
      .select({
        id: product.id,
        value: sql<number>`${sql.raw(expectedQuantitySql('"Product"'))}`,
      })
      .from(product)
      .where(inArray(product.id, fixtureIds));
    const set = await getDb(ctx.db)
      .select({
        id: sql<string>`expected_set."id"`,
        value: sql<number>`expected_set."value"`,
      })
      .from(sql`(${expectedQuantityReadSql()}) expected_set`)
      .where(
        sql`expected_set."id" IN (${sql.join(
          fixtureIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`,
      );
    const byId = (rows: ReadonlyArray<{ id: string; value: number }>) =>
      Object.fromEntries(rows.map(({ id, value }) => [id, Number(value)]));
    expect(byId(set)).toEqual(byId(scalar));

    // The retired `expectedQuantityRange` predicate, preset by preset.
    for (const [from, to] of [
      [undefined, -1],
      [0, 0],
      [1, undefined],
      [5, undefined],
    ] as const) {
      const old = await retired(
        sql`${product.id} IN (SELECT quantity_range."id" FROM (${expectedQuantityReadSql()}) quantity_range
          WHERE ${and(
            from === undefined
              ? undefined
              : sql`quantity_range."value" >= ${from}`,
            to === undefined ? undefined : sql`quantity_range."value" <= ${to}`,
          )})`,
      );
      expect(
        await listed({ expectedQuantityMin: from, expectedQuantityMax: to }),
      ).toEqual(old);
    }
    expect(await listed({ expectedQuantityMax: -1 })).toEqual([all[5]!.id]);

    await createRepoEntity(
      ctx,
      "expense",
      makeExpenseInput({
        name: "Synthetic later acquisition",
        productId: all[0]!.id,
        productQuantity: 1,
        cost: 1,
      }),
    );
    // Membership follows the published variance until the drain catches up.
    expect(await listed({ quantityVarianceFilter: ["matched"] })).toEqual(
      matched,
    );
    await drainStoredDerived(ctx.db);
    expect(await listed({ quantityVarianceFilter: ["matched"] })).toEqual([]);
    expect(await listed({ quantityVarianceFilter: ["mismatched"] })).toEqual(
      sorted([all[0]!.id, all[1]!.id]),
    );
  });

  it("orders purchase reconciliation verdicts disjointly, as the ORs did", async () => {
    const account = await insertWithShortcode(ctx.db, "financialAccount", {
      name: "Synthetic parity account",
      identity: { kind: "cash" },
    });
    const make = async (
      label: string,
      statedTotal: number | null,
      costs: ReadonlyArray<number | null>,
      refund?: number,
    ) => {
      const vendor = await insertWithShortcode(ctx.db, "vendor", {
        name: `Verdict parity ${label}`,
      });
      const row = await insertWithShortcode(ctx.db, "purchase", {
        vendorId: vendor.id,
        date: "2026-09-01",
        statedTotal,
      });
      for (const [index, cost] of costs.entries())
        await insertWithShortcode(ctx.db, "expense", {
          lineKind: "principal",
          purchaseId: row.id,
          name: `Verdict ${label} ${index}`,
          cost,
          date: "2026-09-01",
          costType: "services",
          trade: "other",
        });
      if (refund !== undefined) {
        const transaction = await insertWithShortcode(
          ctx.db,
          "financialTransaction",
          {
            accountId: account.id,
            amount: refund,
            kind: "refund",
            status: "posted",
            postedDate: "2026-09-02",
          },
        );
        await getDb(ctx.db).insert(financialTransactionAllocation).values({
          transactionId: transaction.id,
          purchaseId: row.id,
          amount: refund,
        });
      }
      return row;
    };
    const rows = {
      mismatch: await make("mismatch", 100, [50]),
      excepted: await make("excepted", 100, [40]),
      match: await make("match", 100, [100]),
      noStated: await make("no-stated", null, [30]),
      lineless: await make("lineless", 100, []),
      zero: await make("zero", 0, [0]),
      tolerance: await make("tolerance", 100, [99.99]),
      signed: await make("signed", -100, [-50]),
      unpriced: await make("unpriced", 100, [60, null]),
      refunded: await make("refunded", 100, [80], -20),
      partlyRefunded: await make("partly-refunded", 100, [80], -5),
    };
    await setDataException(
      ctx.db,
      {
        entityId: rows.excepted.shortcode,
        check: "paperwork_mismatch",
        reason: "expected_mismatch",
        note: "Synthetic rounding residual verified by hand.",
      },
      ctx.actor,
    );
    const fixture = Object.values(rows).map(({ shortcode }) => shortcode);

    // The retired `reconciliation` predicate's per-verdict conditions.
    const tolerance = cents(RECONCILIATION_TOLERANCE);
    const total = vendorExpenseTotal(outer(purchase.id));
    const gap = sql`abs(floor((${purchase.statedTotal} * 100)::numeric + 0.5) - floor((${total} * 100)::numeric + 0.5))`;
    const delta = sql`(floor((${total} * 100)::numeric + 0.5) - floor((${purchase.statedTotal} * 100)::numeric + 0.5))`;
    const refundAdjusted = sql`${vendorUnpricedExpenseCount(outer(purchase.id))} = 0
      AND ${delta} < ${-tolerance}
      AND floor((${postedRefundTotal(outer(purchase.id))} * 100)::numeric + 0.5) = ${delta}`;
    const comparable = sql`${purchase.statedTotal} IS NOT NULL
      AND (${gap} <= ${tolerance} OR ${vendorExpenseCount(outer(purchase.id))} > 0)`;
    const verdicts = {
      unknown: sql`(${purchase.statedTotal} IS NULL OR NOT (${comparable}))`,
      match: sql`(${purchase.statedTotal} IS NOT NULL AND ${gap} <= ${tolerance})`,
      refund_adjusted: sql`(${comparable} AND ${gap} > ${tolerance} AND ${refundAdjusted})`,
      mismatch: gapCondition("purchase", "paperwork_mismatch", purchase),
    };
    const retired = async (condition: SQL | undefined) =>
      sorted(
        (
          await getDb(ctx.db)
            .select({ id: purchase.shortcode })
            .from(purchase)
            .where(and(inArray(purchase.shortcode, fixture), condition))
        ).map(({ id }) => id),
      );
    const listed = async (filters: PurchaseFilters) =>
      sorted(
        (
          await purchaseScaffold.read(ctx.db, {
            filters: fromAny<PurchaseFilters, unknown>({
              ...filters,
              ids: fixture,
            }),
            sorts: [],
            pagination: page,
          })
        ).data.map(({ id }) => id),
      );

    // Disjoint: no purchase meets two verdicts' conditions.
    const assigned: string[] = [];
    for (const verdict of purchaseReconciliation.options) {
      const old = await retired(verdicts[verdict]);
      assigned.push(...old);
      expect(await listed({ reconciliation: [verdict] })).toEqual(old);
    }
    expect(sorted(new Set(assigned))).toEqual(sorted(assigned));
    expect(await listed({ reconciliation: ["refund_adjusted"] })).toEqual([
      rows.refunded.shortcode,
    ]);
    // The excepted mismatch has no verdict; Exclude keeps it.
    expect(assigned).not.toContain(rows.excepted.shortcode);
    expect(await listed({ reconciliationExclude: ["mismatch"] })).toEqual(
      await retired(sql`NOT COALESCE(${verdicts.mismatch}, false)`),
    );
  });

  it("filters, sorts and groups projects by the folded completion year", async () => {
    const make = (name: string, endDate: string | null) =>
      insertWithShortcode(ctx.db, "project", {
        name,
        status: "done",
        kind: "household",
        endDate,
      });
    const rows = [
      await make("Parity 2024 build", "2024-06-01"),
      await make("Parity 2025 build", "2025-03-01"),
      await make("Parity 2025 repair", "2025-11-30"),
    ];
    const fixture = rows.map(({ shortcode }) => shortcode);

    // The retired predicate folded the same tree in TS.
    const tree = await loadProjectTree(ctx.db);
    const { dateWindows } = await loadProjectDateWindows(ctx.db, tree);
    const retired = (year: string) =>
      sorted(
        tree.allRows
          .filter((row) => {
            const window = dateWindows.get(row.id);
            return (
              new Set<string>(fixture).has(row.shortcode) &&
              window !== undefined &&
              projectCompletionYear(row, window) === year
            );
          })
          .map((row) => row.shortcode),
      );
    await drainStoredDerived(ctx.db);
    const listed = async (filters: ProjectFilters, sorts: SortParams[] = []) =>
      await projectScaffold.read(ctx.db, {
        filters: fromAny<ProjectFilters, unknown>({ ...filters, ids: fixture }),
        sorts,
        pagination: page,
      });

    for (const year of ["2024", "2025"])
      expect(
        sorted(
          (await listed({ completionYear: [year] })).data.map(({ id }) => id),
        ),
      ).toEqual(retired(year));
    expect(
      (
        await listed({}, [{ orderBy: "completionYear", direction: "desc" }])
      ).data.map(({ id }) => id)[2],
    ).toBe(rows[0]!.shortcode);
    expect(
      (
        await listed(withListGroupBy({}, [{ key: "completionYear" }]))
      ).groups?.map(({ path, count }) => [path.at(-1), count]),
    ).toEqual([
      ["2024", 1],
      ["2025", 2],
    ]);
  });
});
