import type { PurchaseId } from "@cubby/schemas/identifiers";
import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import {
  financialTransaction,
  image,
  productExternalId,
  purchaseImage,
} from "~/server/db/schema";
import {
  clearDataException,
  findProductExternalIdCollisions,
  loadProductDataQualities,
  loadPurchaseDataQualities,
  setDataException,
} from "./data-quality";
import { getDb, insertAndReturn } from "./database-helpers";
import { createExpense } from "./expense";
import { getProductByID, productList } from "./product";
import {
  createPurchase,
  purchaseList,
  reclassifyPurchaseDocument,
} from "./purchase";
import {
  createProductFixture,
  makeExpenseInput,
  makeProductInput,
} from "./repo.fixtures";
import { insertWithShortcode } from "./shortcode-utils";
import { findOrCreateVendor, getVendorByID } from "./vendor";

const page = { pageIndex: 0, pageSize: 100 };

describe("computed purchase and product data quality", () => {
  const ctx = withTestDb();

  const seedPurchase = async (vendorName = "Completeness Supply") => {
    const vendorId = await findOrCreateVendor(ctx.db, vendorName);
    const vendor = await getVendorByID(ctx.db, vendorId);
    const created = await createPurchase(
      ctx.db,
      {
        vendorId: vendor.id,
        orderId: "ORDER-1",
        date: "2026-07-01",
        statedTotal: 25,
        notes: null,
      },
      ctx.actor,
    );
    return created;
  };

  const attachDocument = async (
    purchaseId: PurchaseId,
    documentKind?: typeof purchaseImage.$inferInsert.documentKind,
  ) => {
    const stored = await insertAndReturn(ctx.db, image, {
      key: `test/${crypto.randomUUID()}.pdf`,
      url: `https://example.test/${crypto.randomUUID()}.pdf`,
      filename: "evidence.pdf",
      contentType: "application/pdf",
      size: 12,
      status: "UPLOADED",
    });
    return insertAndReturn(ctx.db, purchaseImage, {
      purchaseId,
      imageId: stored.id,
      ...(documentKind ? { documentKind } : {}),
    });
  };

  it("derives gaps, removes them with evidence, and distinguishes primary documents", async () => {
    const seeded = await seedPurchase();
    const product = await createProductFixture(
      ctx.db,
      makeProductInput({ category: "tools" }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      makeExpenseInput({
        purchaseId: seeded.output.id,
        productId: product.id,
        cost: 25,
      }),
      ctx.actor,
    );
    const legacyDocument = await attachDocument(seeded.entityId);
    expect(legacyDocument.documentKind).toBe("other");
    const quote = await attachDocument(seeded.entityId, "quote");
    await attachDocument(seeded.entityId, "return_authorization");

    const account = await insertWithShortcode(ctx.db, "financialAccount", {
      name: "Completeness Card",
      identity: {
        kind: "credit_card",
        issuer: null,
        network: "visa",
        last4: "1234",
      },
      provisional: false,
      sourceAliases: [],
      notes: null,
    });
    await insertWithShortcode(ctx.db, "financialTransaction", {
      accountId: account.id,
      purchaseId: seeded.entityId,
      kind: "purchase",
      status: "posted",
      amount: 25,
      transactionDate: "2026-07-01",
      postedDate: "2026-07-02",
      merchant: "Completeness Supply",
      rawDescription: null,
      sourceCategory: null,
      sourceRefs: [],
      notes: null,
    });
    for (const status of ["expected", "pending", "void"] as const) {
      await insertWithShortcode(ctx.db, "financialTransaction", {
        accountId: account.id,
        purchaseId: seeded.entityId,
        kind: "purchase",
        status,
        amount: 1,
        transactionDate: "2026-07-01",
        postedDate: null,
        merchant: "Completeness Supply",
        rawDescription: null,
        sourceCategory: null,
        sourceRefs: [{ source: "statement", externalId: status }],
        notes: null,
      });
    }

    let quality = (
      await loadPurchaseDataQualities(ctx.db, [seeded.entityId])
    ).get(seeded.entityId)!;
    expect(quality.gaps.map((gap) => gap.check)).toEqual([
      "primary_document",
      "settlement_reference",
    ]);

    await reclassifyPurchaseDocument(
      ctx.db,
      {
        purchaseId: seeded.output.id,
        imageId: quote.imageId,
        documentKind: "receipt",
      },
      ctx.actor,
    );
    await getDb(ctx.db)
      .update(financialTransaction)
      .set({ sourceRefs: [{ source: "statement", externalId: "row-1" }] })
      .where(eq(financialTransaction.purchaseId, seeded.entityId));

    quality = (await loadPurchaseDataQualities(ctx.db, [seeded.entityId])).get(
      seeded.entityId,
    )!;
    expect(quality).toMatchObject({ status: "complete", gaps: [] });

    const complete = await purchaseList(
      ctx.db,
      { dataStatus: "complete" },
      [{ orderBy: "date", direction: "desc" }],
      page,
    );
    expect(complete.data.map((item) => item.id)).toContain(seeded.output.id);
  });

  it("rolls Product gaps into Purchases and filters exact worklists", async () => {
    const seeded = await seedPurchase();
    const product = await createProductFixture(
      ctx.db,
      makeProductInput({
        manufacturer: UNSPECIFIED_MANUFACTURER,
        model: null,
        category: null,
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      makeExpenseInput({
        purchaseId: seeded.output.id,
        productId: product.id,
        cost: 25,
      }),
      ctx.actor,
    );

    const purchaseQuality = (
      await loadPurchaseDataQualities(ctx.db, [seeded.entityId])
    ).get(seeded.entityId)!;
    expect(
      purchaseQuality.gaps
        .filter((gap) => gap.targetType === "product")
        .map((gap) => [gap.check, gap.targetId]),
    ).toEqual([
      ["product_manufacturer", product.id],
      ["product_category", product.id],
      ["product_model", product.id],
    ]);

    const deepProduct = await getProductByID(ctx.db, product.entityId);
    expect(deepProduct.dataQuality.gaps.map((gap) => gap.check)).toEqual([
      "product_manufacturer",
      "product_category",
      "product_model",
    ]);

    const products = await productList(
      ctx.db,
      { dataGap: "product_model", modelPresenceFilter: "none" },
      [{ orderBy: "name", direction: "asc" }],
      page,
    );
    expect(products.data.map((item) => item.id)).toEqual([product.id]);

    const purchases = await purchaseList(
      ctx.db,
      { dataGap: "product_model" },
      [{ orderBy: "date", direction: "desc" }],
      page,
    );
    expect(purchases.data.map((item) => item.id)).toEqual([seeded.output.id]);
  });

  it("sets, replaces, clears, and validates typed exceptions", async () => {
    const seeded = await seedPurchase();
    let quality = await setDataException(
      ctx.db,
      {
        entityId: seeded.output.id,
        check: "primary_document",
        reason: "unavailable",
        note: "Historical receipt could not be recovered.",
      },
      ctx.actor,
    );
    expect(quality.exceptions).toHaveLength(1);
    expect(quality.gaps.map((gap) => gap.check)).not.toContain(
      "primary_document",
    );

    quality = await setDataException(
      ctx.db,
      {
        entityId: seeded.output.id,
        check: "primary_document",
        reason: "not_issued",
        note: "Vendor did not issue paperwork.",
      },
      ctx.actor,
    );
    expect(quality.exceptions).toEqual([
      expect.objectContaining({ reason: "not_issued" }),
    ]);

    quality = await clearDataException(
      ctx.db,
      { entityId: seeded.output.id, check: "primary_document" },
      ctx.actor,
    );
    expect(quality.exceptions).toEqual([]);
    expect(quality.gaps.map((gap) => gap.check)).toContain("primary_document");

    await expect(
      setDataException(
        ctx.db,
        {
          entityId: seeded.output.id,
          check: "product_model",
          reason: "not_applicable",
          note: "Wrong target type.",
        },
        ctx.actor,
      ),
    ).rejects.toThrow("does not apply to purchase");
  });

  it("targets exceptions and rolls distinct linked Product exceptions into a Purchase", async () => {
    const seeded = await seedPurchase();
    const product = await createProductFixture(
      ctx.db,
      makeProductInput({ category: "tools", model: null }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      makeExpenseInput({
        purchaseId: seeded.output.id,
        productId: product.id,
        cost: 10,
      }),
      ctx.actor,
    );
    // The same Product can appear on multiple Expense lines; its exception must
    // appear only once in the Purchase-level rollup.
    await createExpense(
      ctx.db,
      makeExpenseInput({
        purchaseId: seeded.output.id,
        productId: product.id,
        cost: 15,
      }),
      ctx.actor,
    );

    const productQuality = await setDataException(
      ctx.db,
      {
        entityId: product.id,
        check: "product_model",
        reason: "unavailable",
        note: "The manufacturer does not publish a model number.",
      },
      ctx.actor,
    );
    expect(productQuality.exceptions).toEqual([
      expect.objectContaining({
        check: "product_model",
        targetType: "product",
        targetId: product.id,
      }),
    ]);

    const purchaseQuality = await setDataException(
      ctx.db,
      {
        entityId: seeded.output.id,
        check: "primary_document",
        reason: "unavailable",
        note: "Historical receipt could not be recovered.",
      },
      ctx.actor,
    );
    expect(purchaseQuality.exceptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          check: "primary_document",
          targetType: "purchase",
          targetId: seeded.output.id,
        }),
        expect.objectContaining({
          check: "product_model",
          targetType: "product",
          targetId: product.id,
        }),
      ]),
    );
    expect(
      purchaseQuality.exceptions.filter(
        (exception) =>
          exception.targetType === "product" &&
          exception.targetId === product.id &&
          exception.check === "product_model",
      ),
    ).toHaveLength(1);

    await clearDataException(
      ctx.db,
      { entityId: product.id, check: "product_model" },
      ctx.actor,
    );
    const restored = (
      await loadPurchaseDataQualities(ctx.db, [seeded.entityId])
    ).get(seeded.entityId)!;
    expect(restored.exceptions).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          check: "product_model",
          targetType: "product",
          targetId: product.id,
        }),
      ]),
    );
    expect(restored.gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          check: "product_model",
          targetType: "product",
          targetId: product.id,
        }),
      ]),
    );
  });

  it("applies Amazon ASIN coverage only to Amazon-linked products and reports exact collisions", async () => {
    const amazon = await seedPurchase("Amazon");
    const local = await seedPurchase("Local Hardware");
    const amazonProduct = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Amazon Widget", category: "tools" }),
      ctx.actor,
    );
    const localProduct = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Local Widget", category: "tools" }),
      ctx.actor,
    );
    for (const [purchaseId, productId] of [
      [amazon.output.id, amazonProduct.id],
      [local.output.id, localProduct.id],
    ] as const) {
      await createExpense(
        ctx.db,
        makeExpenseInput({ purchaseId, productId, cost: 25 }),
        ctx.actor,
      );
    }
    const qualities = await loadProductDataQualities(ctx.db, [
      amazonProduct.entityId,
      localProduct.entityId,
    ]);
    expect(
      qualities.get(amazonProduct.entityId)!.gaps.map((gap) => gap.check),
    ).toContain("amazon_asin");
    expect(
      qualities.get(localProduct.entityId)!.gaps.map((gap) => gap.check),
    ).not.toContain("amazon_asin");

    let missingAmazonIds = await productList(
      ctx.db,
      {
        expensePresenceFilter: "has",
        externalIdSource: "amazon",
        externalIdPresenceFilter: "none",
      },
      [{ orderBy: "name", direction: "asc" }],
      page,
    );
    expect(missingAmazonIds.data.map((item) => item.id)).toEqual([
      amazonProduct.id,
      localProduct.id,
    ]);

    await insertAndReturn(ctx.db, productExternalId, {
      productId: amazonProduct.entityId,
      source: "amazon",
      kind: "asin",
      externalId: "B000TEST01",
      url: null,
    });
    missingAmazonIds = await productList(
      ctx.db,
      {
        expensePresenceFilter: "has",
        externalIdSource: "amazon",
        externalIdPresenceFilter: "none",
      },
      [{ orderBy: "name", direction: "asc" }],
      page,
    );
    expect(missingAmazonIds.data.map((item) => item.id)).toEqual([
      localProduct.id,
    ]);

    for (const productId of [amazonProduct.entityId, localProduct.entityId]) {
      await insertAndReturn(ctx.db, productExternalId, {
        productId,
        source: "catalog",
        kind: "catalog_number",
        externalId: "SHARED-1",
        url: null,
      });
    }
    const scopedQuality = (
      await loadProductDataQualities(ctx.db, [amazonProduct.entityId])
    ).get(amazonProduct.entityId)!;
    expect(scopedQuality.gaps.map((gap) => gap.check)).toContain(
      "duplicate_external_id",
    );
    const collisions = await findProductExternalIdCollisions(ctx.db);
    expect(collisions.items).toEqual([
      expect.objectContaining({
        source: "catalog",
        externalId: "SHARED-1",
        products: expect.arrayContaining([
          expect.objectContaining({ id: amazonProduct.id }),
          expect.objectContaining({ id: localProduct.id }),
        ]),
      }),
    ]);
    const exact = await findProductExternalIdCollisions(ctx.db, {
      identifiers: [
        { source: "catalog", kind: "catalog_number", externalId: "SHARED-1" },
        { source: "catalog", kind: "catalog_number", externalId: "MISSING" },
      ],
    });
    expect(exact.results.map((result) => result.status)).toEqual([
      "collision",
      "missing",
    ]);
  });
});
