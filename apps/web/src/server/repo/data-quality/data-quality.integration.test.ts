import { scoredEntities } from "@cubby/schemas/data-quality";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { type SQL, sql } from "drizzle-orm";
import { buildEntity } from "tooling/factories/build";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { entityExternalId, product, productCategory } from "~/server/db/schema";
import { unwrapDb } from "~/server/repo/database-helpers";
import { ensureExternalSources } from "~/server/repo/entity-external-ids";
import { createExpense } from "~/server/repo/expense/crud";
import { createProductCategory } from "~/server/repo/product-category";
import { productList } from "~/server/repo/product/crud";
import { purchaseList } from "~/server/repo/purchase";
import {
  createInventoryFixture,
  createLocationFixture,
  createProductFixture,
  makeExpenseInput,
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";

import { clearDataException, setDataException } from "./exceptions";
import { loadDataQualities } from "./hydrate";
import type { ScoredTable } from "./registry";
import { entryFor, scoreSql, statusSql } from "./sql";

const page = { pageIndex: 0, pageSize: 50 };

/**
 * The list filters, the score sort and the hydrated `dataQuality` all derive
 * from the one registry binding per check. This asserts they agree on real
 * rows — the historical regression class was SQL predicates and JS
 * predicates drifting apart (a `dataGap` filter that disagreed with the
 * badge it filters).
 */
describe("data quality: list filters, sort and hydration agree", () => {
  const ctx = withTestDb();

  const seedProducts = async () => {
    const shelf = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "DQ shelf" }),
      TEST_ACTOR,
    );
    // Stocked, unnamed maker: manufacturer + external id + category + image
    // + price all missing, so the weakest score.
    const weak = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "DQ weak", manufacturer: "(unspecified)" }),
      TEST_ACTOR,
    );
    // Stocked with a maker and a price: still missing external id, category,
    // image — a middling score.
    const middling = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "DQ middling", manufacturer: "Acme", price: 4 }),
      TEST_ACTOR,
    );
    // Neither stocked nor purchased: still scored on catalog identity (only
    // its name is known), and the unscored orphan diagnostic stays visible.
    const catalogOnly = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "DQ catalog unbranded",
        manufacturer: "(unspecified)",
      }),
      TEST_ACTOR,
    );
    for (const item of [weak, middling]) {
      await createInventoryFixture(
        ctx.db,
        {
          productId: item.id,
          locationId: shelf.id,
          amount: { value: 1, unit: "each" },
          placement: "stock",
        },
        TEST_ACTOR,
      );
    }
    return { weak, middling, catalogOnly };
  };

  it("filters by status and gap exactly as the hydrated object reports", async () => {
    const { weak, middling, catalogOnly } = await seedProducts();
    const ids = [weak.entityId, middling.entityId, catalogOnly.entityId];
    const hydrated = await loadDataQualities(ctx.db, "product", ids);

    expect(hydrated.get(weak.entityId)?.status).toBe("needs_data");
    expect(hydrated.get(middling.entityId)?.status).toBe("needs_data");
    expect(hydrated.get(catalogOnly.entityId)).toMatchObject({
      status: "defect",
      score: 30,
    });
    expect(
      hydrated.get(catalogOnly.entityId)?.gaps.map((gap) => gap.check),
    ).toEqual([
      "product_orphaned",
      "product_manufacturer",
      "product_external_id",
      "product_category",
    ]);
    expect(hydrated.get(weak.entityId)?.gaps.map((gap) => gap.check)).toContain(
      "product_manufacturer",
    );
    expect(
      hydrated.get(middling.entityId)?.gaps.map((gap) => gap.check),
    ).not.toContain("product_manufacturer");

    const listed = async (filters: Parameters<typeof productList>[1]) =>
      new Set(
        (await productList(ctx.db, filters, [], page)).data.map(
          (row) => row.id,
        ),
      );

    const needsData = await listed({ dataStatus: "needs_data" });
    expect(needsData.has(weak.id)).toBe(true);
    expect(needsData.has(middling.id)).toBe(true);
    expect(needsData.has(catalogOnly.id)).toBe(false);

    const complete = await listed({ dataStatus: "complete" });
    expect(complete.has(catalogOnly.id)).toBe(false);
    expect(complete.has(weak.id)).toBe(false);
    const defects = await listed({ dataStatus: "defect" });
    expect(defects.has(catalogOnly.id)).toBe(true);

    const noMaker = await listed({ dataGap: ["product_manufacturer"] });
    expect(noMaker.has(weak.id)).toBe(true);
    expect(noMaker.has(middling.id)).toBe(false);
    expect(noMaker.has(catalogOnly.id)).toBe(true);
  });

  it("sorts by the same score the hydrated object carries", async () => {
    const { weak, middling, catalogOnly } = await seedProducts();
    const hydrated = await loadDataQualities(ctx.db, "product", [
      weak.entityId,
      middling.entityId,
      catalogOnly.entityId,
    ]);
    const score = (row: typeof weak) => hydrated.get(row.entityId)!.score!;
    expect(score(weak)).toBeLessThan(score(catalogOnly));
    expect(score(catalogOnly)).toBeLessThan(score(middling));

    const { data } = await productList(
      ctx.db,
      { nameFilter: "DQ " },
      [{ orderBy: "dataQuality", direction: "asc" }],
      page,
    );
    const ordered = [weak, catalogOnly, middling];
    expect(data.map((row) => row.id)).toEqual(ordered.map((row) => row.id));
    expect(data.map((row) => row.dataQuality.score)).toEqual(
      ordered.map(score),
    );
  });

  it("counts an active exception as satisfied until its evidence changes", async () => {
    const { weak } = await seedProducts();
    const before = (
      await loadDataQualities(ctx.db, "product", [weak.entityId])
    ).get(weak.entityId)!;

    const excepted = await setDataException(
      ctx.db,
      {
        entityId: weak.id,
        check: "product_manufacturer",
        reason: "not_applicable",
        note: "An unbranded bag; the maker never catalogued it.",
      },
      TEST_ACTOR,
    );
    expect(excepted.exceptions).toContainEqual(
      expect.objectContaining({
        check: "product_manufacturer",
        state: "active",
      }),
    );
    expect(excepted.gaps.map((gap) => gap.check)).not.toContain(
      "product_manufacturer",
    );
    expect(excepted.score).toBeGreaterThan(before.score!);
    const noMaker = new Set(
      (
        await productList(
          ctx.db,
          { dataGap: ["product_manufacturer"] },
          [],
          page,
        )
      ).data.map((row) => row.id),
    );
    expect(noMaker.has(weak.id)).toBe(false);

    const cleared = await clearDataException(
      ctx.db,
      { entityId: weak.id, check: "product_manufacturer" },
      TEST_ACTOR,
    );
    expect(cleared.exceptions).toEqual([]);
    expect(cleared.score).toBe(before.score);
  });

  // Failure modes: a sale/discard Expense passing as purchase evidence; a
  // soft-deleted category or a blank external id passing as identity; a
  // missing category scoring like any other identity gap.
  it("product: requires live identity and acquiring evidence", async () => {
    const shelf = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "DQ identity shelf" }),
      TEST_ACTOR,
    );
    const category = await createProductCategory(
      ctx.db,
      buildEntity("productCategory", { name: "DQ doomed category" }),
      TEST_ACTOR,
    );
    const sold = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "DQ sold only",
        manufacturer: "Acme",
        categoryId: category.output.id,
      }),
      TEST_ACTOR,
    );
    const bought = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "DQ bought", manufacturer: "Acme" }),
      TEST_ACTOR,
    );
    for (const item of [sold, bought])
      await createInventoryFixture(
        ctx.db,
        {
          productId: item.id,
          locationId: shelf.id,
          amount: { value: 1, unit: "each" },
          placement: "stock",
        },
        TEST_ACTOR,
      );
    // A resale is a product-linked Expense whose money flows in.
    await createExpense(
      ctx.db,
      buildEntity(
        "expense",
        makeExpenseInput({ name: "DQ resale", productId: sold.id, cost: -20 }),
      ),
      TEST_ACTOR,
    );
    await createExpense(
      ctx.db,
      buildEntity(
        "expense",
        makeExpenseInput({ name: "DQ buy", productId: bought.id, cost: 20 }),
      ),
      TEST_ACTOR,
    );
    await ensureExternalSources(ctx.db, ["synthetic"]);
    await unwrapDb(ctx.db)
      .insert(entityExternalId)
      .values({
        entityId: sold.entityId,
        entityKind: "product" as const,
        source: "synthetic",
        kind: "retailer_sku",
        externalId: "   ",
        isPrimary: true,
      });
    await unwrapDb(ctx.db)
      .update(productCategory)
      .set({ deletedAt: new Date() })
      .where(sql`${productCategory.id} = ${category.entityId}`);

    const hydrated = await loadDataQualities(ctx.db, "product", [
      sold.entityId,
      bought.entityId,
    ]);
    const soldQuality = hydrated.get(sold.entityId)!;
    const soldGaps = soldQuality.gaps.map((gap) => gap.check);
    expect(soldGaps).toContain("product_unpurchased");
    expect(soldGaps).toContain("product_category");
    expect(soldGaps).toContain("product_external_id");
    // A missing category is indispensable identity: capped at 69.
    expect(soldQuality.score).toBeLessThanOrEqual(69);
    expect(
      hydrated.get(bought.entityId)?.gaps.map((gap) => gap.check),
    ).not.toContain("product_unpurchased");
  });

  // Failure modes: a catalog-only Product (no spend, no stock) reading as not
  // assessed instead of earning its name and identity; a known price earning
  // nothing without stock; an unpriced historical Product charged a price gap
  // it can never close; an explicit zero price read as missing; stock no
  // longer requiring a price; a blank name passing as identity; a missing
  // category escaping its cap.
  it("product: scores catalog identity and any known price without stock", async () => {
    const shelf = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "DQ catalog shelf" }),
      TEST_ACTOR,
    );
    const category = await createProductCategory(
      ctx.db,
      buildEntity("productCategory", { name: "DQ catalog category" }),
      TEST_ACTOR,
    );
    const categoryId = category.output.id;
    const make = (
      name: string,
      input: { categoryId?: typeof categoryId; price?: number },
    ) =>
      createProductFixture(
        ctx.db,
        makeProductInput({ name, manufacturer: "Acme", ...input }),
        TEST_ACTOR,
      );
    const catalog = await make("DQ catalog only", { categoryId });
    const priced = await make("DQ catalog priced", { price: 4 });
    const zero = await make("DQ catalog zero", { categoryId, price: 0 });
    const refunded = await make("DQ refunded only", { categoryId });
    const stocked = await make("DQ stocked unpriced", { categoryId });
    const uncategorized = await make("DQ uncategorized", { price: 4 });
    const blank = await make("DQ blank name", { categoryId });
    await createInventoryFixture(
      ctx.db,
      {
        productId: stocked.id,
        locationId: shelf.id,
        amount: { value: 1, unit: "each" },
        placement: "stock",
      },
      TEST_ACTOR,
    );
    // A refund is spend without an acquisition cost, so no price derives.
    await createExpense(
      ctx.db,
      buildEntity(
        "expense",
        makeExpenseInput({
          name: "DQ refund",
          productId: refunded.id,
          cost: -20,
        }),
      ),
      TEST_ACTOR,
    );
    await ensureExternalSources(ctx.db, ["synthetic"]);
    await unwrapDb(ctx.db)
      .insert(entityExternalId)
      .values({
        entityId: uncategorized.entityId,
        entityKind: "product" as const,
        source: "synthetic",
        kind: "retailer_sku",
        externalId: "DQ-SKU-1",
        isPrimary: true,
      });
    await unwrapDb(ctx.db)
      .update(product)
      .set({ name: "   " })
      .where(sql`${product.id} = ${blank.entityId}`);

    const rows = [
      catalog,
      priced,
      zero,
      refunded,
      stocked,
      uncategorized,
      blank,
    ];
    const hydrated = await loadDataQualities(
      ctx.db,
      "product",
      rows.map((row) => row.entityId),
    );
    const quality = (row: (typeof rows)[number]) => hydrated.get(row.entityId)!;
    const gaps = (row: (typeof rows)[number]) =>
      quality(row).gaps.map((gap) => gap.check);

    // Weights: name 3, manufacturer 2, external id 2, category 3, price 3.
    // Name + maker + category of name + maker + external id + category.
    expect(quality(catalog).score).toBe(80);
    expect(gaps(catalog)).not.toContain("product_price");
    // Name + maker + price of those plus external id + category.
    expect(quality(priced).score).toBe(61.54);
    expect(quality(zero).score).toBe(84.62);
    expect(gaps(zero)).not.toContain("product_price");
    expect(quality(refunded).score).toBe(80);
    expect(gaps(refunded)).not.toContain("product_price");
    // Stock adds the price gap plus the weight-1 image and purchase checks.
    expect(gaps(stocked)).toContain("product_price");
    expect(quality(stocked).score).toBe(53.33);
    // 10/13 weighted, but a missing category caps at 69.
    expect(gaps(uncategorized)).toEqual([
      "product_orphaned",
      "product_category",
    ]);
    expect(quality(uncategorized).score).toBe(69);
    expect(gaps(blank)).toContain("product_name");
    expect(quality(blank).score).toBe(50);

    const { data } = await productList(ctx.db, { nameFilter: "DQ " }, [], page);
    const listed = new Map(data.map((row) => [row.id, row.dataQuality.score]));
    for (const row of rows.filter((row) => row !== blank))
      expect(listed.get(row.id)).toBe(quality(row).score);
  });

  // Failure mode: a planned (future) line, which may be unpriced by policy,
  // still flagging its Purchase as having an unpriced line.
  it("purchase: an unpriced future line is not an unpriced expense", async () => {
    const line = await createExpense(
      ctx.db,
      buildEntity(
        "expense",
        makeExpenseInput({
          name: "DQ planned line",
          cost: undefined,
          future: true,
          vendor: "DQ planned vendor",
          orderId: "DQ-PLAN-1",
        }),
      ),
      TEST_ACTOR,
    );
    const purchaseId = line.output.purchaseId;
    if (!purchaseId) throw new Error("Fixture has no Purchase");
    const planned = (
      await purchaseList(ctx.db, { dataGap: ["unpriced_expense"] }, [], page)
    ).data.map((row) => row.id);
    expect(planned).not.toContain(purchaseId);

    await createExpense(
      ctx.db,
      buildEntity(
        "expense",
        makeExpenseInput({
          name: "DQ spent unpriced line",
          cost: undefined,
          future: false,
          purchaseId,
        }),
      ),
      TEST_ACTOR,
    );
    const spent = (
      await purchaseList(ctx.db, { dataGap: ["unpriced_expense"] }, [], page)
    ).data.map((row) => row.id);
    expect(spent).toContain(purchaseId);
  });

  it("rolls a linked product's gap up onto the purchase's dataGap filter", async () => {
    const { weak } = await seedProducts();
    const line = await createExpense(
      ctx.db,
      buildEntity(
        "expense",
        makeExpenseInput({
          name: "DQ line",
          productId: weak.id,
          vendor: "DQ vendor",
          orderId: "DQ-1",
        }),
      ),
      TEST_ACTOR,
    );
    const purchaseId = line.output.purchaseId;
    if (!purchaseId) throw new Error("Fixture has no Purchase");

    const rolledUp = (
      await purchaseList(ctx.db, { dataGap: ["product_image"] }, [], page)
    ).data;
    expect(rolledUp.map((row) => row.id)).toContain(purchaseId);
    const quality = rolledUp.find((row) => row.id === purchaseId)?.dataQuality;
    expect(quality?.relatedGaps).toContainEqual(
      expect.objectContaining({
        check: "product_image",
        targetType: "product",
        targetId: parseShortcodeFor("product", weak.id),
      }),
    );
    // The purchase's own score ignores the related product's gaps.
    expect(quality?.gaps.map((gap) => gap.check)).not.toContain(
      "product_image",
    );
  });
});

/**
 * Postgres has no common-subexpression elimination: every inlined copy of a
 * correlated policy subquery is planned separately, and planner memory grows
 * with each copy until the statement ends. The FinancialTransaction score once
 * planned ~0.4 GB by itself (its list rows and hydration statements ~0.85 GB
 * together), which OOM-killed the 2 GB test PostgreSQL under four concurrent
 * list-smoke probes and costs the same on every production list request.
 * Planning cost is independent of row count, so an empty table measures it.
 */
describe("data quality: score and status SQL planning", () => {
  const ctx = withTestDb();
  const PLANNER_BUDGET_KB = 128 * 1024;
  const explained = z.tuple([
    z.object({ Planning: z.object({ "Memory Used": z.number() }) }),
  ]);

  it("plans every scored entity's score and status within the budget", async () => {
    const plannerKb = async (expression: SQL, t: ScoredTable) => {
      const result = await unwrapDb(ctx.db).execute(
        sql`EXPLAIN (MEMORY, FORMAT JSON) SELECT ${expression} FROM ${t}`,
      );
      return explained.parse(result.rows[0]?.["QUERY PLAN"])[0].Planning[
        "Memory Used"
      ];
    };
    const used: Record<string, number> = {};
    for (const entity of scoredEntities) {
      const t = entryFor(entity).table;
      used[`${entity} score`] = await plannerKb(scoreSql(entity, t), t);
      used[`${entity} status`] = await plannerKb(statusSql(entity, t), t);
    }
    // Names each statement over budget with its planner kB.
    expect(
      Object.entries(used).filter(([, kb]) => kb > PLANNER_BUDGET_KB),
    ).toEqual([]);
  });
});
