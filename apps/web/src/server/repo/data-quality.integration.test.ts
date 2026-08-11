import type { PurchaseId } from "@cubby/schemas/identifiers";
import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import { eq } from "drizzle-orm";
import { insertSettlementTransaction } from "tooling/settlement-fixtures";
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
  mergePurchases,
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
    await insertSettlementTransaction(ctx.db, {
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
      await insertSettlementTransaction(ctx.db, {
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

  it("reports related Product gaps separately and filters exact worklists", async () => {
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
      purchaseQuality.relatedGaps
        .filter((gap) => gap.targetType === "product")
        .map((gap) => [gap.check, gap.targetId]),
    ).toEqual([
      ["product_manufacturer", product.id],
      ["product_category", product.id],
    ]);

    const deepProduct = await getProductByID(ctx.db, product.entityId);
    expect(deepProduct.dataQuality.gaps.map((gap) => gap.check)).toEqual([
      "product_manufacturer",
      "product_category",
    ]);

    const products = await productList(
      ctx.db,
      { dataGap: "product_category" },
      [{ orderBy: "name", direction: "asc" }],
      page,
    );
    expect(products.data.map((item) => item.id)).toEqual([product.id]);

    const purchases = await purchaseList(
      ctx.db,
      { dataGap: "product_category" },
      [{ orderBy: "date", direction: "desc" }],
      page,
    );
    expect(purchases.data.map((item) => item.id)).toEqual([seeded.output.id]);
  });

  it("does not flag a stated-total difference explained by posted refunds", async () => {
    const seeded = await seedPurchase("Refund Quality Supply");
    await createExpense(
      ctx.db,
      makeExpenseInput({ purchaseId: seeded.output.id, cost: 20 }),
      ctx.actor,
    );
    const account = await insertWithShortcode(ctx.db, "financialAccount", {
      name: "Refund Quality Card",
      identity: {
        kind: "credit_card",
        issuer: null,
        network: "visa",
        last4: "5454",
      },
      provisional: false,
      sourceAliases: [],
      notes: null,
    });
    const refund = await insertSettlementTransaction(ctx.db, {
      accountId: account.id,
      purchaseId: seeded.entityId,
      kind: "refund",
      status: "pending",
      amount: -5,
      transactionDate: "2026-07-02",
      postedDate: null,
      merchant: "Refund Quality Supply",
      rawDescription: null,
      sourceCategory: null,
      sourceRefs: [],
      notes: null,
    });

    let quality = (
      await loadPurchaseDataQualities(ctx.db, [seeded.entityId])
    ).get(seeded.entityId)!;
    expect(quality.gaps.map((gap) => gap.check)).toContain(
      "paperwork_mismatch",
    );

    await getDb(ctx.db)
      .update(financialTransaction)
      .set({ status: "posted", postedDate: "2026-07-03" })
      .where(eq(financialTransaction.id, refund.id));

    quality = (await loadPurchaseDataQualities(ctx.db, [seeded.entityId])).get(
      seeded.entityId,
    )!;
    expect(quality.gaps.map((gap) => gap.check)).not.toContain(
      "paperwork_mismatch",
    );
    expect(
      (
        await purchaseList(ctx.db, { dataGap: "paperwork_mismatch" }, [], page)
      ).data.map((purchase) => purchase.id),
    ).not.toContain(seeded.output.id);
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

  it("marks an exception stale when child evidence changes", async () => {
    const seeded = await seedPurchase("Stale Evidence Supply");
    const document = await attachDocument(seeded.entityId);
    const excepted = await setDataException(
      ctx.db,
      {
        entityId: seeded.output.id,
        check: "primary_document",
        reason: "unavailable",
        note: "No primary paperwork was available at review time.",
      },
      ctx.actor,
    );
    expect(excepted.exceptions[0]?.state).toBe("active");

    await reclassifyPurchaseDocument(
      ctx.db,
      {
        purchaseId: seeded.output.id,
        imageId: document.imageId,
        documentKind: "receipt",
      },
      ctx.actor,
    );
    const refreshed = (
      await loadPurchaseDataQualities(ctx.db, [seeded.entityId])
    ).get(seeded.entityId)!;
    expect(refreshed.gaps.map((gap) => gap.check)).not.toContain(
      "primary_document",
    );
    expect(refreshed.exceptions).toEqual([
      expect.objectContaining({ check: "primary_document", state: "stale" }),
    ]);
  });

  it("marks an exception stale when mergePurchases changes the evidence it covered", async () => {
    // Regression coverage for the bug where `mergePurchases`/`foldChargeInto`
    // repointed Expenses, FinancialTransactions, and documents onto the
    // survivor without ever calling `touchDataQualityTargets` — so a stored
    // exception kept matching its old fingerprint and stayed reported
    // "active" even though the evidence underneath it had just changed.
    //
    // Deliberately built so the `paperwork_mismatch` gap is STILL true after
    // the merge (just a different-sized mismatch), not resolved by it — a
    // scenario where the raw gap disappears would mark the exception stale
    // for the wrong reason (`evaluateTargetQuality` treats "gap no longer
    // applies" as stale too), which would pass even with the bug still live.
    // This is the actual failure mode from the bug report: a mismatch that
    // nobody has reviewed must not stay silently covered by a stale-but-still-
    // "active" exception.
    const vendorId = await findOrCreateVendor(ctx.db, "Merge DQ Supply");
    const vendor = await getVendorByID(ctx.db, vendorId);

    const keep = await createPurchase(
      ctx.db,
      {
        vendorId: vendor.id,
        orderId: null,
        date: "2026-07-01",
        statedTotal: 100,
        notes: null,
      },
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      makeExpenseInput({ purchaseId: keep.output.id, cost: 50 }),
      ctx.actor,
    );

    // $100 stated vs. $50 of lines is a real paperwork_mismatch gap — except
    // it as a known-wrong vendor invoice.
    const excepted = await setDataException(
      ctx.db,
      {
        entityId: keep.output.id,
        check: "paperwork_mismatch",
        reason: "expected_mismatch",
        note: "Vendor invoice total confirmed wrong by phone.",
      },
      ctx.actor,
    );
    expect(excepted.exceptions).toEqual([
      expect.objectContaining({
        check: "paperwork_mismatch",
        state: "active",
      }),
    ]);

    // A second charge of the same vendor carries a line that belongs on this
    // order — merging it in changes the survivor's expense total (and so the
    // SIZE of the mismatch, $50 -> $40) without resolving it. The exception
    // was reviewed against the OLD mismatch, not this new one.
    const loser = await createPurchase(
      ctx.db,
      {
        vendorId: vendor.id,
        orderId: null,
        date: "2026-07-01",
        statedTotal: null,
        notes: null,
      },
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      makeExpenseInput({ purchaseId: loser.output.id, cost: 10 }),
      ctx.actor,
    );

    await mergePurchases(
      ctx.db,
      { keepId: keep.output.id, mergeIds: [loser.output.id] },
      ctx.actor,
    );

    const merged = (
      await loadPurchaseDataQualities(ctx.db, [keep.entityId])
    ).get(keep.entityId)!;
    // The mismatch is still live — $100 stated vs. $60 of lines now — so this
    // is the case that matters: the check is STILL a real gap, and the stored
    // exception must not keep hiding it just because it once covered a
    // smaller, already-reviewed mismatch.
    expect(merged.gaps.map((gap) => gap.check)).toContain("paperwork_mismatch");
    expect(merged.exceptions).toEqual([
      expect.objectContaining({
        check: "paperwork_mismatch",
        state: "stale",
      }),
    ]);
  });

  it("targets exceptions and reports distinct linked Product exceptions separately", async () => {
    const seeded = await seedPurchase("Amazon");
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
        check: "amazon_asin",
        reason: "unavailable",
        note: "The historical listing cannot be recovered.",
      },
      ctx.actor,
    );
    expect(productQuality.exceptions).toEqual([
      expect.objectContaining({
        check: "amazon_asin",
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
    expect(purchaseQuality.exceptions).toEqual([
      expect.objectContaining({
        check: "primary_document",
        targetType: "purchase",
        targetId: seeded.output.id,
      }),
    ]);
    expect(purchaseQuality.relatedExceptions).toEqual([
      expect.objectContaining({
        check: "amazon_asin",
        targetType: "product",
        targetId: product.id,
      }),
    ]);
    expect(
      purchaseQuality.relatedExceptions.filter(
        (exception) =>
          exception.targetType === "product" &&
          exception.targetId === product.id &&
          exception.check === "amazon_asin",
      ),
    ).toHaveLength(1);

    await clearDataException(
      ctx.db,
      { entityId: product.id, check: "amazon_asin" },
      ctx.actor,
    );
    const restored = (
      await loadPurchaseDataQualities(ctx.db, [seeded.entityId])
    ).get(seeded.entityId)!;
    expect(restored.relatedExceptions).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          check: "amazon_asin",
          targetType: "product",
          targetId: product.id,
        }),
      ]),
    );
    expect(restored.relatedGaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          check: "amazon_asin",
          targetType: "product",
          targetId: product.id,
        }),
      ]),
    );
  });

  it("applies Amazon ASIN coverage only to Amazon-linked products and rejects duplicate identifiers", async () => {
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

    await insertAndReturn(ctx.db, productExternalId, {
      productId: amazonProduct.entityId,
      source: "catalog",
      kind: "catalog_number",
      externalId: "SHARED-1",
      url: null,
    });
    await expect(
      createProductFixture(
        ctx.db,
        makeProductInput({
          name: "Conflicting catalog product",
          externalIds: [
            {
              source: "catalog",
              kind: "catalog_number",
              externalId: "SHARED-1",
              url: null,
            },
          ],
        }),
        ctx.actor,
      ),
    ).rejects.toThrow("already belongs");
    const collisions = await findProductExternalIdCollisions(ctx.db);
    expect(collisions.items).toEqual([]);
    const sourceWide = await findProductExternalIdCollisions(ctx.db, {
      source: "CATALOG",
    });
    expect(sourceWide.items).toEqual([]);
    const exact = await findProductExternalIdCollisions(ctx.db, {
      identifiers: [
        { source: "catalog", kind: "catalog_number", externalId: "SHARED-1" },
        { source: "catalog", kind: "catalog_number", externalId: "MISSING" },
      ],
    });
    expect(exact.results.map((result) => result.status)).toEqual([
      "unique",
      "missing",
    ]);
  });
});
