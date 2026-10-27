import { scoredEntities } from "@cubby/schemas/data-quality";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { testShortcode } from "@cubby/schemas/testing";
import { eq, type SQL, sql } from "drizzle-orm";
import { buildEntity } from "tooling/factories/build";
import { taxonomyShortcode } from "tooling/product-category-fixtures";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { TEXT_WHITESPACE, hasText, trimText } from "~/lib/text-whitespace";
import { hasTextSql, trimTextSql } from "~/server/db/computed/text-whitespace";
import { withDatabaseOperationMetrics } from "~/server/db/db-observability";
import { unwrapDb } from "~/server/db/helpers";
import {
  dataExceptionRecord,
  entityExternalId,
  product,
  productCategory,
  purchase,
} from "~/server/db/schema";
import { createExpense } from "~/server/domains/expense/repo/crud";
import { createProductCategory } from "~/server/domains/product-category/repo/product-category";
import {
  buildProductWhere,
  productList,
} from "~/server/domains/product/repo/crud";
import { attachProductComponents } from "~/server/domains/product/repo/product-components";
import { purchaseList } from "~/server/domains/purchase/repo/purchase";
import { findOrCreateVendor } from "~/server/domains/vendor/repo/vendor";
import { readRecordWorkQueue } from "~/server/domains/work/service/work-queue-read";
import { ensureExternalSources } from "~/server/generic/entity-links/repo/entity-external-ids";
import { publishQualityFixtures } from "~/server/testing/quality.fixtures";
import {
  createImageFixture,
  insertEntityAttachments,
  createInventoryFixture,
  createLocationFixture,
  createProductFixture,
  createProductIdentityFixture,
  insertEntityFixtures,
  makeExpenseInput,
  makeLocationInput,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

import { qualityCheck } from "./builders";
import { storedEntryFor } from "./entries";
import { clearDataException, setDataException } from "./exceptions";
import { loadDataQualities } from "./hydrate";
import type { ScoredTable } from "./registry";
import { scoreSql, statusSql } from "./sql";

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

  it("treats Unicode whitespace identically in stored checks and SQL", async () => {
    for (const value of [
      null,
      "",
      TEXT_WHITESPACE,
      `${TEXT_WHITESPACE}value${TEXT_WHITESPACE}`,
      "\u200b",
    ]) {
      const result = await unwrapDb(ctx.db).execute<{
        present: boolean;
        trimmed: string | null;
      }>(sql`
        SELECT ${hasTextSql(sql`${value}::text`)} AS present,
          ${trimTextSql(sql`${value}::text`)} AS trimmed
      `);
      expect(result.rows[0]).toEqual({
        present: hasText(value),
        trimmed: value === null ? null : trimText(value),
      });
      expect(
        qualityCheck.required<{ value: string | null }>("value")({ value }),
      ).toBe(hasText(value) ? "pass" : "gap");
      expect(value === null ? null : trimText(value)).toBe(
        value?.trim() ?? null,
      );
    }
  });

  const publishedQualities: typeof loadDataQualities = async (...args) => {
    await publishQualityFixtures(ctx.db, "product");
    return loadDataQualities(...args);
  };
  const publishedProductList: typeof productList = async (...args) => {
    await publishQualityFixtures(ctx.db, "product");
    return productList(...args);
  };
  const publishedProductWhere: typeof buildProductWhere = async (...args) => {
    await publishQualityFixtures(ctx.db, "product");
    return buildProductWhere(...args);
  };
  const publishedRecordWorkQueue: typeof readRecordWorkQueue = async (
    ...args
  ) => {
    await publishQualityFixtures(ctx.db, "product");
    return readRecordWorkQueue(...args);
  };

  it("missing display images prevent perfect quality even without inventory", async () => {
    const row = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "DQ image-free catalog item",
        commodity: true,
        categoryId: taxonomyShortcode("food"),
      }),
      TEST_ACTOR,
    );
    await createExpense(
      ctx.db,
      makeExpenseInput({
        name: "DQ catalog acquisition",
        productId: row.id,
        cost: 2,
      }),
      TEST_ACTOR,
    );
    const quality = (
      await publishedQualities(ctx.db, "product", [row.entityId])
    ).get(row.entityId)!;
    expect(quality.score).toBeLessThan(100);
    expect(quality.gaps.map((gap) => gap.check)).toContain(
      "product_display_image",
    );
    const scores = await unwrapDb(ctx.db)
      .execute(sql`SELECT ${scoreSql("product")} AS score
      FROM ${storedEntryFor("product").table} WHERE ${storedEntryFor("product").table.id} = ${row.entityId}`);
    expect(Number(scores.rows[0]?.score)).toBe(quality.score);
    await expect(
      setDataException(
        ctx.db,
        {
          entityId: row.id,
          check: "product_display_image",
          reason: "unavailable",
          note: "Synthetic missing image",
        },
        TEST_ACTOR,
      ),
    ).rejects.toThrow("unavailable is not allowed for product_display_image.");
    const cover = await createImageFixture(ctx.db, "dq-catalog-cover");
    await insertEntityAttachments(ctx.db, {
      entityId: row.entityId,
      imageId: cover.id,
      sortOrder: 0,
    });
    const complete = (
      await publishedQualities(ctx.db, "product", [row.entityId])
    ).get(row.entityId)!;
    expect(complete).toMatchObject({
      score: 100,
      status: "complete",
      gaps: [],
    });
  });

  const seedProducts = async () => {
    const shelf = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "DQ shelf" }),
      TEST_ACTOR,
    );
    // Stocked, unnamed maker: brandName + external id + category + image
    // + price all missing, so the weakest score.
    const weak = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "DQ weak",
        brandId: null,
        model: null,
      }),
      TEST_ACTOR,
    );
    // Stocked with a maker and a price: still missing external id, category,
    // image — a middling score.
    const middling = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "DQ middling",
        brandId: await findOrCreateVendor(ctx.db, "Acme"),
        price: 4,
        model: null,
      }),
      TEST_ACTOR,
    );
    // Neither stocked nor purchased: still scored on catalog identity (only
    // its name is known), and the unscored orphan diagnostic stays visible.
    const catalogOnly = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "DQ catalog unbranded",
        model: null,
        brandId: null,
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

  // Catalog price gaps must not repeat a kit-pricing walk for every Product.
  // A kit-priced part remains priced even without its own acquiring Expense.
  it("reads published price checks across catalog gaps and bounded hydration", async () => {
    const { weak, middling } = await seedProducts();
    const queueKeys = async () =>
      (
        await publishedRecordWorkQueue(ctx.db, {
          id: weak.id,
          memberPartyId: null,
          memberOnly: false,
        })
      ).items.map((row) => row.key);
    for (let index = 0; index < 64; index++)
      await createProductIdentityFixture(
        ctx.db,
        makeProductInput({ name: `Synthetic price catalog ${index}` }),
        TEST_ACTOR,
      );
    const kit = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic priced kit" }),
      TEST_ACTOR,
    );
    await attachProductComponents(
      ctx.db,
      kit.entityId,
      [{ productId: weak.entityId, quantity: 4 }],
      TEST_ACTOR,
    );
    const whereBefore = await publishedProductWhere(ctx.db, {
      dataGap: "product_price",
    });
    const before = await unwrapDb(ctx.db)
      .select({ id: product.id })
      .from(product)
      .where(whereBefore);
    expect(before.map((row) => row.id)).toContain(weak.entityId);
    expect(await queueKeys()).toContain(`productsMissingPrice:${weak.id}`);
    const excepted = await setDataException(
      ctx.db,
      {
        entityId: weak.id,
        check: "product_price",
        reason: "unavailable",
        note: "Synthetic historical price is unavailable.",
      },
      TEST_ACTOR,
    );
    expect(excepted.exceptions).toContainEqual(
      expect.objectContaining({ check: "product_price", state: "active" }),
    );
    await publishQualityFixtures(ctx.db, "product");
    const filteredException = await unwrapDb(ctx.db)
      .select({ id: product.id })
      .from(product)
      .where(whereBefore);
    expect(filteredException.map((row) => row.id)).not.toContain(weak.entityId);
    expect(await queueKeys()).not.toContain(`productsMissingPrice:${weak.id}`);
    await createExpense(
      ctx.db,
      makeExpenseInput({
        name: "Synthetic kit acquisition",
        productId: kit.id,
        cost: 10,
        productQuantity: 2,
      }),
      TEST_ACTOR,
    );
    const where = await publishedProductWhere(ctx.db, {
      dataGap: "product_price",
    });
    const after = await unwrapDb(ctx.db)
      .select({ id: product.id })
      .from(product)
      .where(where);
    expect(after.map((row) => row.id)).not.toContain(weak.entityId);
    expect(await queueKeys()).not.toContain(`productsMissingPrice:${weak.id}`);
    const hydrated = await publishedQualities(ctx.db, "product", [
      weak.entityId,
      middling.entityId,
    ]);
    expect(
      hydrated.get(weak.entityId)?.gaps.map((gap) => gap.check),
    ).not.toContain("product_price");
    expect(hydrated.get(weak.entityId)?.exceptions).toContainEqual(
      expect.objectContaining({ check: "product_price", state: "active" }),
    );
    const planNode = z.object({
      "Relation Name": z.string().optional(),
      "Actual Loops": z.number().optional(),
      get Plans() {
        return z.array(planNode).optional();
      },
    });
    const explained = await unwrapDb(ctx.db).execute(
      sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT ${product.id} FROM ${product} WHERE ${where}`,
    );
    const plan = z
      .array(z.object({ Plan: planNode }))
      .parse(explained.rows[0]?.["QUERY PLAN"])[0];
    if (!plan) throw new Error("Missing query plan");
    let edgeScans = 0;
    const visit = (node: z.infer<typeof planNode>) => {
      if (node["Relation Name"] === "EntityLink")
        edgeScans += node["Actual Loops"] ?? 0;
      node.Plans?.forEach(visit);
    };
    visit(plan.Plan);
    expect(edgeScans).toBe(0);
  });

  it("filters by status and gap exactly as the hydrated object reports", async () => {
    const { weak, middling, catalogOnly } = await seedProducts();
    const ids = [weak.entityId, middling.entityId, catalogOnly.entityId];
    const hydrated = await publishedQualities(ctx.db, "product", ids);

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
      "product_brand",
      "product_external_id",
      "product_category",
      "product_display_image",
    ]);
    expect(hydrated.get(weak.entityId)?.gaps.map((gap) => gap.check)).toContain(
      "product_brand",
    );
    expect(
      hydrated.get(middling.entityId)?.gaps.map((gap) => gap.check),
    ).not.toContain("product_brand");

    const listed = async (filters: Parameters<typeof productList>[1]) =>
      new Set(
        (await publishedProductList(ctx.db, filters, [], page)).data.map(
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
    // Any-of: every picked status, not only the first.
    const either = await listed({ dataStatus: ["needs_data", "defect"] });
    expect(either.has(weak.id)).toBe(true);
    expect(either.has(middling.id)).toBe(true);
    expect(either.has(catalogOnly.id)).toBe(true);

    const noMaker = await listed({ dataGap: ["product_brand"] });
    expect(noMaker.has(weak.id)).toBe(true);
    expect(noMaker.has(middling.id)).toBe(false);
    expect(noMaker.has(catalogOnly.id)).toBe(true);
  });

  it("sorts by the same score the hydrated object carries", async () => {
    const { weak, middling, catalogOnly } = await seedProducts();
    const hydrated = await publishedQualities(ctx.db, "product", [
      weak.entityId,
      middling.entityId,
      catalogOnly.entityId,
    ]);
    const score = (row: typeof weak) => hydrated.get(row.entityId)!.score!;
    expect(score(weak)).toBeLessThan(score(catalogOnly));
    expect(score(catalogOnly)).toBeLessThan(score(middling));

    const { data } = await publishedProductList(
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

  it("counts a durable waiver as satisfied until explicitly cleared", async () => {
    const { weak } = await seedProducts();
    const before = (
      await publishedQualities(ctx.db, "product", [weak.entityId])
    ).get(weak.entityId)!;

    const excepted = await setDataException(
      ctx.db,
      {
        entityId: weak.id,
        check: "product_brand",
        reason: "not_applicable",
        note: "An unbranded bag; the maker never catalogued it.",
      },
      TEST_ACTOR,
    );
    expect(excepted.exceptions).toContainEqual(
      expect.objectContaining({
        check: "product_brand",
        state: "active",
      }),
    );
    expect(excepted.gaps.map((gap) => gap.check)).not.toContain(
      "product_brand",
    );
    expect(excepted.score).toBeGreaterThan(before.score!);
    const noMaker = new Set(
      (
        await publishedProductList(
          ctx.db,
          { dataGap: ["product_brand"] },
          [],
          page,
        )
      ).data.map((row) => row.id),
    );
    expect(noMaker.has(weak.id)).toBe(false);

    const cleared = await clearDataException(
      ctx.db,
      { entityId: weak.id, check: "product_brand" },
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
        model: null,
        brandId: await findOrCreateVendor(ctx.db, "Acme"),
        categoryId: category.output.id,
      }),
      TEST_ACTOR,
    );
    const bought = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "DQ bought",
        brandId: await findOrCreateVendor(ctx.db, "Acme"),
      }),
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

    const hydrated = await publishedQualities(ctx.db, "product", [
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
    const make = async (
      name: string,
      input: { categoryId?: typeof categoryId; price?: number },
    ) =>
      createProductFixture(
        ctx.db,
        makeProductInput({
          name,
          brandId: await findOrCreateVendor(ctx.db, "Acme"),
          model: null,
          ...input,
        }),
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
    const hydrated = await publishedQualities(
      ctx.db,
      "product",
      rows.map((row) => row.entityId),
    );
    const quality = (row: (typeof rows)[number]) => hydrated.get(row.entityId)!;
    const gaps = (row: (typeof rows)[number]) =>
      quality(row).gaps.map((gap) => gap.check);

    // Weights: name 3, brandName 2, external id 2, category 3, price 3.
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
      "product_display_image",
    ]);
    expect(quality(uncategorized).score).toBe(69);
    expect(gaps(blank)).toContain("product_name");
    expect(quality(blank).score).toBe(50);

    const { data } = await publishedProductList(
      ctx.db,
      { nameFilter: "DQ " },
      [],
      page,
    );
    const listed = new Map(data.map((row) => [row.id, row.dataQuality.score]));
    for (const row of rows.filter((row) => row !== blank))
      expect(listed.get(row.id)).toBe(quality(row).score);
  });

  // Failure modes: model-only or external-ID-only records stay in Research,
  // category policy still demands a second identifier, or SQL filtering and
  // scoring disagree with hydration. Blank/deleted evidence must not qualify.
  it("product: either model or a live external identifier satisfies identity", async () => {
    const make = async (name: string, model: string | null) =>
      createProductFixture(
        ctx.db,
        makeProductInput({
          name: `DQ identifier ${name}`,
          brandId: await findOrCreateVendor(ctx.db, "Acme"),
          categoryId: taxonomyShortcode("tools"),
          model,
        }),
        TEST_ACTOR,
      );
    const modelOnly = await make("model", "EX-100");
    const externalOnly = await make("external", null);
    const both = await make("both", "EX-200");
    const neither = await make("neither", "   ");
    const deleted = await make("deleted", null);
    await ensureExternalSources(ctx.db, ["synthetic"]);
    await unwrapDb(ctx.db)
      .insert(entityExternalId)
      .values([
        {
          entityId: externalOnly.entityId,
          entityKind: "product",
          source: "synthetic",
          kind: "retailer_sku",
          externalId: "EX-SKU-100",
          isPrimary: true,
        },
        {
          entityId: both.entityId,
          entityKind: "product",
          source: "synthetic",
          kind: "retailer_sku",
          externalId: "EX-SKU-200",
          isPrimary: true,
        },
        {
          entityId: neither.entityId,
          entityKind: "product",
          source: "synthetic",
          kind: "retailer_sku",
          externalId: "   ",
          isPrimary: true,
        },
        {
          entityId: deleted.entityId,
          entityKind: "product",
          source: "synthetic",
          kind: "retailer_sku",
          externalId: "EX-SKU-DELETED",
          isPrimary: true,
          deletedAt: new Date(),
        },
      ]);
    const rows = [modelOnly, externalOnly, both, neither, deleted];
    const hydrated = await publishedQualities(
      ctx.db,
      "product",
      rows.map((row) => row.entityId),
    );
    const gaps = (row: typeof modelOnly) =>
      hydrated.get(row.entityId)?.gaps.map((gap) => gap.check);
    expect(gaps(modelOnly)).not.toContain("product_external_id");
    expect(gaps(externalOnly)).not.toContain("product_external_id");
    expect(gaps(both)).not.toContain("product_external_id");
    expect(gaps(neither)).toContain("product_external_id");
    expect(gaps(deleted)).toContain("product_external_id");
    expect(hydrated.get(modelOnly.entityId)?.score).toBe(
      hydrated.get(both.entityId)?.score,
    );
    expect(hydrated.get(externalOnly.entityId)?.score).toBe(
      hydrated.get(both.entityId)?.score,
    );
    const filtered = await publishedProductList(
      ctx.db,
      { nameFilter: "DQ identifier", dataGap: ["product_external_id"] },
      [],
      page,
    );
    expect(filtered.data.map((row) => row.id).sort()).toEqual(
      [neither.id, deleted.id].sort(),
    );
    const queue = await publishedRecordWorkQueue(ctx.db, {
      id: externalOnly.id,
      memberPartyId: null,
      memberOnly: false,
    });
    expect(queue.items.filter((row) => row.family === "research")).toEqual([]);
    await unwrapDb(ctx.db)
      .update(product)
      .set({ model: null })
      .where(eq(product.id, modelOnly.entityId));
    const reopened = await publishedQualities(ctx.db, "product", [
      modelOnly.entityId,
    ]);
    expect(
      reopened.get(modelOnly.entityId)?.gaps.map((gap) => gap.check),
    ).toContain("product_external_id");
  });

  it("product: a commodity is not expected to carry a brand, identifier or ASIN", async () => {
    const make = (name: string, commodity: boolean) =>
      createProductFixture(
        ctx.db,
        makeProductInput({
          name: `DQ commodity ${name}`,
          brandId: null,
          categoryId: taxonomyShortcode("food"),
          model: null,
          commodity,
        }),
        TEST_ACTOR,
      );
    const flagged = await make("flagged", true);
    const twin = await make("twin", false);
    const vendorId = await findOrCreateVendor(ctx.db, "Amazon.com");
    const [order] = await insertEntityFixtures(ctx.db, purchase, "purchase", [
      {
        shortcode: testShortcode("purchase", "PUR-DQ-COMMODITY"),
        vendorId,
        date: "2026-01-15",
        displayLabel: "DQ commodity order",
      },
    ]);
    for (const row of [flagged, twin]) {
      await createExpense(
        ctx.db,
        makeExpenseInput({
          name: `DQ commodity line ${row.id}`,
          productId: row.id,
          purchaseId: order
            ? parseShortcodeFor("purchase", order.shortcode)
            : null,
          cost: 2,
          productQuantity: 1,
        }),
        TEST_ACTOR,
      );
    }
    const identityChecks = [
      "amazon_asin",
      "product_brand",
      "product_external_id",
    ];
    const gapsOf = async (row: typeof flagged) =>
      (await publishedQualities(ctx.db, "product", [row.entityId]))
        .get(row.entityId)
        ?.gaps.map((gap) => gap.check)
        .filter((check) => identityChecks.includes(check))
        .sort();
    expect(await gapsOf(flagged)).toEqual([]);
    expect(await gapsOf(twin)).toEqual([...identityChecks].sort());
    const filtered = await publishedProductList(
      ctx.db,
      { nameFilter: "DQ commodity", dataGap: ["amazon_asin"] },
      [],
      page,
    );
    expect(filtered.data.map((row) => row.id)).toEqual([twin.id]);
    await unwrapDb(ctx.db)
      .update(product)
      .set({ commodity: false })
      .where(eq(product.id, flagged.entityId));
    expect(await gapsOf(flagged)).toEqual([...identityChecks].sort());
  });

  // Retired checks can remain stored until the post-deploy contract migration.
  it("product: ignores retired exceptions during reads and supported exception writes", async () => {
    const row = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic retired-check product",
        model: null,
      }),
      TEST_ACTOR,
    );
    await unwrapDb(ctx.db).insert(dataExceptionRecord).values({
      entityId: row.entityId,
      entityKind: "product",
      check: "retired_synthetic_check",
      reason: "unavailable",
      note: "Synthetic retired metadata awaiting contraction.",
    });
    const quality = await publishedQualities(ctx.db, "product", [row.entityId]);
    expect(quality.get(row.entityId)?.exceptions).toEqual([]);
    const excepted = await setDataException(
      ctx.db,
      {
        entityId: row.id,
        check: "product_external_id",
        reason: "unavailable",
        note: "No identifier on the synthetic item.",
      },
      TEST_ACTOR,
    );
    expect(excepted.exceptions).toEqual([
      expect.objectContaining({
        check: "product_external_id",
        state: "active",
      }),
    ]);
  });

  // Retained identifier waivers survive both unrelated edits and changed identity.
  it("product: identifier waivers survive unrelated edits and changed evidence", async () => {
    const row = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({
        name: "DQ identifier exception",
        brandId: await findOrCreateVendor(ctx.db, "Acme"),
        categoryId: taxonomyShortcode("tools"),
        model: null,
      }),
      TEST_ACTOR,
    );
    await unwrapDb(ctx.db).insert(dataExceptionRecord).values({
      entityId: row.entityId,
      entityKind: "product",
      check: "product_external_id",
      reason: "not_issued",
      note: "Synthetic component has no issued identifier.",
    });
    await unwrapDb(ctx.db)
      .update(product)
      .set({ notes: "Synthetic unrelated note" })
      .where(eq(product.id, row.entityId));
    const accepted = await publishedQualities(ctx.db, "product", [
      row.entityId,
    ]);
    expect(accepted.get(row.entityId)?.exceptions).toContainEqual(
      expect.objectContaining({
        check: "product_external_id",
        state: "active",
      }),
    );
    await unwrapDb(ctx.db)
      .update(product)
      .set({ model: "EX-300" })
      .where(eq(product.id, row.entityId));
    const changed = await publishedQualities(ctx.db, "product", [row.entityId]);
    expect(changed.get(row.entityId)?.exceptions).toContainEqual(
      expect.objectContaining({
        check: "product_external_id",
        state: "active",
      }),
    );
    expect(
      changed.get(row.entityId)?.gaps.map((gap) => gap.check),
    ).not.toContain("product_external_id");
  });

  // Mixed batches retain waivers and do not add source-evidence reads for
  // rows with a waiver.
  it("product: retains durable waivers across a mixed batch", async () => {
    const knownBrandId = await findOrCreateVendor(ctx.db, "Acme");
    const make = (
      name: string,
      brandId: typeof knownBrandId | null = knownBrandId,
    ) =>
      createProductFixture(
        ctx.db,
        makeProductInput({
          name,
          brandId,
          categoryId: taxonomyShortcode("tools"),
          model: null,
        }),
        TEST_ACTOR,
      );
    const [accepted, open, mismatched, both] = [
      await make("DQ batch accepted"),
      await make("DQ batch open"),
      await make("DQ batch mismatched"),
      await make("DQ batch both", null),
    ];
    // Two checks on one row, and a check no other row in the batch compares.
    for (const [check, reason] of [
      ["product_external_id", "not_issued"],
      ["product_brand", "unavailable"],
    ] as const)
      await setDataException(
        ctx.db,
        { entityId: both.id, check, reason, note: "Synthetic both." },
        TEST_ACTOR,
      );
    await unwrapDb(ctx.db)
      .insert(dataExceptionRecord)
      .values([
        {
          entityId: accepted.entityId,
          entityKind: "product",
          check: "product_external_id",
          reason: "not_issued",
          note: "Synthetic component has no issued identifier.",
        },
        {
          entityId: mismatched.entityId,
          entityKind: "product",
          check: "product_external_id",
          reason: "not_issued",
          note: "Synthetic evidence has since changed.",
        },
      ]);
    const qualities = await publishedQualities(ctx.db, "product", [
      accepted.entityId,
      open.entityId,
      mismatched.entityId,
      both.entityId,
    ]);
    const state = (
      id: typeof accepted.entityId,
      check: "product_external_id" | "product_brand",
    ) => ({
      gap: qualities.get(id)?.gaps.some((gap) => gap.check === check),
      exception: qualities
        .get(id)
        ?.exceptions.find((exception) => exception.check === check)?.state,
    });
    expect([
      state(accepted.entityId, "product_external_id"),
      state(open.entityId, "product_external_id"),
      state(mismatched.entityId, "product_external_id"),
      state(both.entityId, "product_external_id"),
      state(both.entityId, "product_brand"),
      state(accepted.entityId, "product_brand"),
    ]).toEqual([
      { gap: false, exception: "active" },
      { gap: true, exception: undefined },
      { gap: false, exception: "active" },
      { gap: false, exception: "active" },
      { gap: false, exception: "active" },
      { gap: false, exception: undefined },
    ]);
    const statements = (ids: (typeof accepted.entityId)[]) =>
      withDatabaseOperationMetrics(async (metrics) => {
        await loadDataQualities(ctx.db, "product", ids);
        return metrics.queryCount;
      });
    expect(await statements([accepted.entityId])).toBe(
      await statements([open.entityId]),
    );
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

    await publishQualityFixtures(ctx.db, "product");
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
      const t = storedEntryFor(entity).table;
      used[`${entity} score`] = await plannerKb(scoreSql(entity, t), t);
      used[`${entity} status`] = await plannerKb(statusSql(entity, t), t);
    }
    // Names each statement over budget with its planner kB.
    expect(
      Object.entries(used).filter(([, kb]) => kb > PLANNER_BUDGET_KB),
    ).toEqual([]);
  });
});
