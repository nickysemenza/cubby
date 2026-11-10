import { dataQuality } from "@cubby/schemas/data-quality-shape";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { eq, sql } from "drizzle-orm";
import { buildEntity } from "tooling/factories/build";
import { taxonomyShortcode } from "tooling/product-category-fixtures";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { TEXT_WHITESPACE, hasText, trimText } from "~/lib/text-whitespace";
import { hasTextSql, trimTextSql } from "~/server/db/computed/text-whitespace";
import { unwrapDb } from "~/server/db/helpers";
import {
  dataExceptionRecord,
  entityExternalId,
  product,
  productCategory,
} from "~/server/db/schema";
import { createExpense } from "~/server/domains/expense/repo/crud";
import { createProductCategory } from "~/server/domains/product-category/repo/product-category";
import { purchaseScaffold } from "~/server/domains/purchase/repo/purchase";
import { findOrCreateVendor } from "~/server/domains/vendor/repo/vendor";
import { ensureExternalSources } from "~/server/generic/entity-links/repo/entity-external-ids";
import { publishQualityFixtures } from "~/server/testing/quality.fixtures";
import {
  createImageFixture,
  createInventoryFixture,
  createLocationFixture,
  createProductFixture,
  createProductIdentityFixture,
  insertEntityAttachments,
  listProductsFixture,
  makeExpenseInput,
  makeLocationInput,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

import { qualityCheck } from "./builders";
import { clearDataException, setDataException } from "./exceptions";
import { loadDataQualities } from "./hydrate";

const page = { pageIndex: 0, pageSize: 50 };

/**
 * The list filters, the missing-count sort and the hydrated `dataQuality` all derive
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
  const publishedProductList: typeof listProductsFixture = async (...args) => {
    await publishQualityFixtures(ctx.db, "product");
    return listProductsFixture(...args);
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
    expect(quality.gaps.map((gap) => gap.check)).toContain(
      "product_display_image",
    );
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

  it("filters by status and gap exactly as the hydrated object reports", async () => {
    const { weak, middling, catalogOnly } = await seedProducts();
    const ids = [weak.entityId, middling.entityId, catalogOnly.entityId];
    const hydrated = await publishedQualities(ctx.db, "product", ids);

    expect(hydrated.get(weak.entityId)?.status).toBe("needs_data");
    expect(hydrated.get(middling.entityId)?.status).toBe("needs_data");
    expect(hydrated.get(catalogOnly.entityId)).toMatchObject({
      status: "defect",
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

    const listed = async (filters: Parameters<typeof listProductsFixture>[1]) =>
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

  it("counts a durable waiver as satisfied until explicitly cleared", async () => {
    const { weak } = await seedProducts();

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
    expect(gaps(catalog)).not.toContain("product_price");
    // Name + maker + price of those plus external id + category.
    expect(gaps(zero)).not.toContain("product_price");
    expect(gaps(refunded)).not.toContain("product_price");
    // Stock adds the price gap plus the weight-1 image and purchase checks.
    expect(gaps(stocked)).toContain("product_price");
    // 10/13 weighted, but a missing category caps at 69.
    expect(gaps(uncategorized)).toEqual([
      "product_orphaned",
      "product_category",
      "product_display_image",
    ]);
    expect(gaps(blank)).toContain("product_name");

    const { data } = await publishedProductList(
      ctx.db,
      { nameFilter: "DQ " },
      [],
      page,
    );
    const listed = new Map(data.map((row) => [row.id, row.dataQuality.gaps]));
    for (const row of rows.filter((row) => row !== blank))
      expect(listed.get(row.id)).toEqual(quality(row).gaps);
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
      await purchaseScaffold.read(ctx.db, {
        filters: { dataGap: ["product_image"] },
        sorts: [],
        pagination: page,
      })
    ).data;
    expect(rolledUp.map((row) => row.id)).toContain(purchaseId);
    const quality = dataQuality
      .optional()
      .parse(rolledUp.find((row) => row.id === purchaseId)?.dataQuality);
    expect(quality?.relatedGaps).toContainEqual(
      expect.objectContaining({
        check: "product_image",
        targetType: "product",
        targetId: parseShortcodeFor("product", weak.id),
      }),
    );
    // The purchase's own status ignores the related product's gaps.
    expect(quality?.gaps.map((gap) => gap.check)).not.toContain(
      "product_image",
    );
  });
});
