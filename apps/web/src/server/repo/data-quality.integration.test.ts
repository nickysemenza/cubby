import type { PurchaseId } from "@cubby/schemas/identifiers";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import { eq, inArray } from "drizzle-orm";
import { insertSettlementTransaction } from "tooling/settlement-fixtures";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  financialTransaction,
  financialTransactionAllocation,
  productExternalId,
  productImage,
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
  createImageFixture,
  createInventoryFixture,
  createLocationFixture,
  createProductFixture,
  makeExpenseInput,
  makeLocationInput,
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
    const stored = await insertWithShortcode(ctx.db, "image", {
      key: `test/${crypto.randomUUID()}.pdf`,
      filename: "evidence.pdf",
      contentType: "application/pdf",
      size: 12,
      status: "UPLOADED",
    });
    const joinRow = await insertAndReturn(ctx.db, purchaseImage, {
      purchaseId,
      imageId: stored.id,
      ...(documentKind ? { documentKind } : {}),
    });
    // `reclassifyPurchaseDocument` now takes the public `IMG-` shortcode, not
    // the join row's raw uuid FK.
    return {
      ...joinRow,
      imageShortcode: parseShortcodeFor("image", stored.shortcode),
    };
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
        imageId: quote.imageShortcode,
        documentKind: "receipt",
      },
      ctx.actor,
    );
    await getDb(ctx.db)
      .update(financialTransaction)
      .set({ sourceRefs: [{ source: "statement", externalId: "row-1" }] })
      .where(
        inArray(
          financialTransaction.id,
          getDb(ctx.db)
            .select({ id: financialTransactionAllocation.transactionId })
            .from(financialTransactionAllocation)
            .where(
              eq(financialTransactionAllocation.purchaseId, seeded.entityId),
            ),
        ),
      );

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

  // `product_image` is the only product check scoped to STOCK rather than to
  // the shared expense-or-inventory scope, so the scoping is the property worth
  // locking: an unscoped version would light up every sold-off and historical
  // product in the catalogue and stop discriminating. The SQL filter and the TS
  // emitter are separate implementations of that rule, so both are asserted.
  it("opens product_image only for stocked products, and only for a real photo", async () => {
    const seeded = await seedPurchase("Image Check Supply");
    const location = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Image Check Shelf" }),
      ctx.actor,
    );
    const soldOff = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Sold Off No Image",
        category: "tools",
        manufacturer: "Acme",
      }),
      ctx.actor,
    );
    const stocked = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Stocked No Image",
        category: "tools",
        manufacturer: "Acme",
      }),
      ctx.actor,
    );
    for (const item of [soldOff, stocked]) {
      await createExpense(
        ctx.db,
        makeExpenseInput({
          purchaseId: seeded.output.id,
          productId: item.id,
          cost: 25,
        }),
        ctx.actor,
      );
    }

    const checksFor = async (id: (typeof stocked)["entityId"]) =>
      (await getProductByID(ctx.db, id)).dataQuality.gaps.map(
        (gap) => gap.check,
      );

    // Spend alone is NOT scope for this check, unlike every other product check.
    expect(await checksFor(soldOff.entityId)).not.toContain("product_image");
    expect(await checksFor(stocked.entityId)).not.toContain("product_image");

    await createInventoryFixture(
      ctx.db,
      {
        productId: stocked.id,
        locationId: location.id,
        amount: { value: 1, unit: "each" },
      },
      ctx.actor,
    );

    expect(await checksFor(stocked.entityId)).toContain("product_image");
    expect(await checksFor(soldOff.entityId)).not.toContain("product_image");

    // The SQL filter must agree with the TS emitter above — they are written
    // twice and can drift silently.
    const gappy = await productList(
      ctx.db,
      { dataGap: "product_image" },
      [{ orderBy: "name", direction: "asc" }],
      page,
    );
    expect(gappy.data.map((item) => item.id)).toEqual([stocked.id]);

    const manual = await createImageFixture(ctx.db, "manual", {
      contentType: "application/pdf",
      filename: "manual.pdf",
    });
    await insertAndReturn(ctx.db, productImage, {
      productId: stocked.entityId,
      imageId: manual.id,
    });
    expect(await checksFor(stocked.entityId)).toContain("product_image");

    // A render-failed image does not count either.
    const broken = await createImageFixture(ctx.db, "broken", {
      renderStatus: "failed",
    });
    await insertAndReturn(ctx.db, productImage, {
      productId: stocked.entityId,
      imageId: broken.id,
    });
    expect(await checksFor(stocked.entityId)).toContain("product_image");

    const photo = await createImageFixture(ctx.db, "cover");
    await insertAndReturn(ctx.db, productImage, {
      productId: stocked.entityId,
      imageId: photo.id,
    });
    expect(await checksFor(stocked.entityId)).not.toContain("product_image");

    const afterPhoto = await productList(
      ctx.db,
      { dataGap: "product_image" },
      [{ orderBy: "name", direction: "asc" }],
      page,
    );
    expect(afterPhoto.data.map((item) => item.id)).toEqual([]);
  });

  it("admits an unavailable exception on product_image", async () => {
    const seeded = await seedPurchase("Image Exception Supply");
    const location = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Image Exception Shelf" }),
      ctx.actor,
    );
    const item = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Retired Listing",
        category: "tools",
        manufacturer: "Acme",
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      makeExpenseInput({
        purchaseId: seeded.output.id,
        productId: item.id,
        cost: 25,
      }),
      ctx.actor,
    );
    await createInventoryFixture(
      ctx.db,
      {
        productId: item.id,
        locationId: location.id,
        amount: { value: 1, unit: "each" },
      },
      ctx.actor,
    );

    // Rejection first: a successful exception closes the gap, and a closed gap
    // trips the active-gap guard rather than the reason allowlist.
    await expect(
      setDataException(
        ctx.db,
        {
          entityId: item.id,
          check: "product_image",
          reason: "not_issued",
          note: "Wrong reason for this check.",
        },
        ctx.actor,
      ),
      // oxlint-disable-next-line vitest/require-to-throw-message -- The rejection itself is contractual; the exact message is intentionally not.
    ).rejects.toThrow();

    const quality = await setDataException(
      ctx.db,
      {
        entityId: item.id,
        check: "product_image",
        reason: "unavailable",
        note: "Discontinued; every listing retired and no canonical asset survives.",
      },
      ctx.actor,
    );
    expect(quality.gaps.map((gap) => gap.check)).not.toContain("product_image");
    expect(quality.exceptions).toContainEqual(
      expect.objectContaining({ check: "product_image", state: "active" }),
    );
  });

  it("reports a brand-new purchase as empty, not as a paperwork mismatch", async () => {
    // `seedPurchase` states $25 and books nothing, which is every purchase the
    // moment it is created. Before the zero-expense guard the whole stated
    // total read as an unexplained gap, so `paperwork_mismatch` — the only
    // defect-kind purchase check — fired on creation and made the purchase
    // report `status: "defect"` with no line yet booked.
    const seeded = await seedPurchase("Brand New Supply");

    const quality = (
      await loadPurchaseDataQualities(ctx.db, [seeded.entityId])
    ).get(seeded.entityId)!;
    const checks = quality.gaps.map((gap) => gap.check);
    expect(checks).toContain("empty_expenses");
    expect(checks).not.toContain("paperwork_mismatch");
    expect(quality.status).not.toBe("defect");

    // The `dataGap=` filter is a hand-written SQL twin of the in-memory check;
    // asserting it separately is what keeps the two from drifting apart.
    expect(
      (
        await purchaseList(ctx.db, { dataGap: "paperwork_mismatch" }, [], page)
      ).data.map((purchase) => purchase.id),
    ).not.toContain(seeded.output.id);

    await createExpense(
      ctx.db,
      makeExpenseInput({ purchaseId: seeded.output.id, cost: 20 }),
      ctx.actor,
    );
    expect(
      (await loadPurchaseDataQualities(ctx.db, [seeded.entityId]))
        .get(seeded.entityId)!
        .gaps.map((gap) => gap.check),
    ).toContain("paperwork_mismatch");
    expect(
      (
        await purchaseList(ctx.db, { dataGap: "paperwork_mismatch" }, [], page)
      ).data.map((purchase) => purchase.id),
    ).toContain(seeded.output.id);
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

  // Every product identity check was missing from EXCEPTION_REASONS, and an
  // absent entry admits no reason at all — so a product whose model number the
  // manufacturer never issued (a kit component sold only inside the kit) could
  // never clear its gap. Each check keeps its own reason set, so assert one
  // allowed and one rejected reason per check rather than trusting the map.
  it("admits typed exceptions on every product identity check", async () => {
    // One product per check, not one shared row: `product_category` requires a
    // null category and `product_model` only applies to the model-required
    // categories, so the two gaps can never be open on the same product.
    const cases = [
      {
        check: "product_manufacturer",
        input: { manufacturer: UNSPECIFIED_MANUFACTURER, category: null },
        allowedReason: "not_applicable",
        rejectedReason: "expected_mismatch",
      },
      {
        check: "product_category",
        input: { manufacturer: "Acme", category: null },
        allowedReason: "insufficient_detail",
        rejectedReason: "not_issued",
      },
      {
        check: "product_model",
        input: { manufacturer: "Acme", category: "tools" },
        allowedReason: "not_issued",
        rejectedReason: "not_applicable",
      },
    ] as const;

    const seeded = await seedPurchase("Exception Reason Supply");

    for (const { check, input, allowedReason, rejectedReason } of cases) {
      const product = await createProductFixture(
        ctx.db,
        makeProductInput({ ...input, name: `Test ${check}`, model: null }),
        ctx.actor,
      );
      // Identity gaps only open on a product with quality scope — one that has
      // an expense or inventory behind it. A bare product row has no gaps, so
      // without this the exception would be rejected as "not an active gap".
      await createExpense(
        ctx.db,
        makeExpenseInput({
          purchaseId: seeded.output.id,
          productId: product.id,
          cost: 25,
        }),
        ctx.actor,
      );

      const before = await getProductByID(ctx.db, product.entityId);
      expect(before.dataQuality.gaps.map((gap) => gap.check)).toContain(check);

      // Rejection is asserted first: a successful exception closes the gap, and
      // a closed gap fails the earlier active-gap guard instead of the reason
      // allowlist, which would make this assertion pass for the wrong reason.
      await expect(
        setDataException(
          ctx.db,
          {
            entityId: product.id,
            check,
            reason: rejectedReason,
            note: "Reason outside this check's allowlist.",
          },
          ctx.actor,
        ),
      ).rejects.toThrow(`${rejectedReason} is not allowed for ${check}`);

      const quality = await setDataException(
        ctx.db,
        {
          entityId: product.id,
          check,
          reason: allowedReason,
          note: `${check} does not exist for this product.`,
        },
        ctx.actor,
      );
      expect(quality.gaps.map((gap) => gap.check)).not.toContain(check);
      expect(quality.exceptions).toContainEqual(
        expect.objectContaining({ check, reason: allowedReason }),
      );
    }
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
        imageId: document.imageShortcode,
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

    // `unique` only ever meant "exactly one live owner, whoever that is", so it
    // read as a clean pass even when the id sat on a DIFFERENT product — which
    // is how three duplicate pairs were nearly missed in one import session.
    // Naming the product the caller intends to write to splits the answer.
    const identifiers = [
      { source: "catalog", kind: "catalog_number", externalId: "SHARED-1" },
      { source: "catalog", kind: "catalog_number", externalId: "MISSING" },
    ] as const;
    const asOwner = await findProductExternalIdCollisions(ctx.db, {
      productId: amazonProduct.id,
      identifiers: [...identifiers],
    });
    expect(asOwner.results.map((result) => result.status)).toEqual([
      "owned_by_this",
      "missing",
    ]);
    const asOther = await findProductExternalIdCollisions(ctx.db, {
      productId: localProduct.id,
      identifiers: [...identifiers],
    });
    expect(asOther.results.map((result) => result.status)).toEqual([
      "owned_by_other",
      "missing",
    ]);
    expect(asOther.results[0]?.products.map((row) => row.id)).toEqual([
      amazonProduct.id,
    ]);
  });
  // ⚠️ REGRESSION (SQL operator precedence). `dataStatus: "needs_data"` matched
  // ZERO products in production — 1,193 real gaps read as a clean bill of
  // health, and a location-scoped audit (the documented worklist entry point)
  // reported nothing to do. `productDataGapCondition` returned a bare
  // `scope AND missing AND NOT exception`, so `productNeedsDataCondition`'s
  // `NOT <defect>` bound to `scope` alone and rendered
  // `(<missing group>) AND NOT scope AND <collision> AND …`. Every disjunct in
  // the missing group requires that same scope, so the conjunction was a
  // contradiction. The two halves each looked correct in isolation, which is
  // why this asserts the INTERSECTION against the same thing computed in
  // application code rather than against a hand-written expected count.
  it("intersects dataStatus with locationIdFilter instead of cancelling it", async () => {
    const seeded = await seedPurchase("Worklist Supply");
    const shelf = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Worklist Shelf" }),
      ctx.actor,
    );
    const otherShelf = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Worklist Other Shelf" }),
      ctx.actor,
    );

    // Missing category — a needs_data gap, on the shelf under audit.
    const incomplete = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Worklist Incomplete",
        manufacturer: "Acme",
        category: null,
      }),
      ctx.actor,
    );
    // Same gap, a DIFFERENT shelf. Locks the intersection down in the widening
    // direction too: a filter that silently ignored the location scope would
    // pass every assertion below except this one.
    const elsewhere = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Worklist Elsewhere",
        manufacturer: "Acme",
        category: null,
      }),
      ctx.actor,
    );
    // Fully enriched, on the shelf under audit.
    const complete = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Worklist Complete",
        manufacturer: "Acme",
        category: "tools",
        model: "AC-1",
      }),
      ctx.actor,
    );

    for (const item of [incomplete, elsewhere, complete]) {
      await createExpense(
        ctx.db,
        makeExpenseInput({
          purchaseId: seeded.output.id,
          productId: item.id,
          cost: 25,
        }),
        ctx.actor,
      );
    }
    for (const [item, place] of [
      [incomplete, shelf],
      [elsewhere, otherShelf],
      [complete, shelf],
    ] as const) {
      await createInventoryFixture(
        ctx.db,
        {
          productId: item.id,
          locationId: place.id,
          amount: { value: 1, unit: "each" },
        },
        ctx.actor,
      );
    }
    const photo = await createImageFixture(ctx.db, "worklist-cover");
    await insertAndReturn(ctx.db, productImage, {
      productId: complete.entityId,
      imageId: photo.id,
    });

    const sorts = [{ orderBy: "name", direction: "asc" as const }];
    const scoped = await productList(
      ctx.db,
      { locationIdFilter: shelf.id, dataStatus: "needs_data" },
      sorts,
      page,
    );

    expect(scoped.data.length).toBeGreaterThan(0);
    expect(scoped.data.map((item) => item.id)).toContain(incomplete.id);
    expect(scoped.data.map((item) => item.id)).not.toContain(complete.id);
    expect(scoped.data.map((item) => item.id)).not.toContain(elsewhere.id);
    expect(scoped.count).toBe(scoped.data.length);

    // The contract the audit entry point actually depends on: filtering by both
    // in SQL === filtering by location in SQL, then by status in TS.
    const byLocationOnly = await productList(
      ctx.db,
      { locationIdFilter: shelf.id },
      sorts,
      page,
    );
    const expected = byLocationOnly.data
      .filter((item) => item.dataQuality.status === "needs_data")
      .map((item) => item.id);
    expect(expected.length).toBeGreaterThan(0);
    expect(scoped.data.map((item) => item.id)).toEqual(expected);
  });

  // Same precedence class, opposite direction: `productList`/`purchaseList`
  // spell "complete" as `NOT <anyDataGap>`, and an unparenthesized `a OR b`
  // there renders `NOT a OR b` — so anything carrying a DEFECT was reported
  // complete. This fixture carries a missing-data gap AND a defect, which is
  // exactly the input the broken form let through.
  //
  // Purchase-side only: the product-side defect (`duplicate_external_id`) is
  // unconstructible here by design — `ProductExternalId_source_kind_externalId_key`
  // guarantees a live identifier has at most one owner. The parenthesization of
  // BOTH sides is locked down in `data-quality.unit.test.ts` instead.
  it("keeps a defective purchase out of the complete worklist", async () => {
    const seeded = await seedPurchase("Defect Complete Supply");
    const item = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Defect Complete Line", manufacturer: "Acme" }),
      ctx.actor,
    );
    // A cost that cannot reconcile against the purchase's statedTotal of 25 —
    // `paperwork_mismatch`, the purchase-side defect. The purchase also still
    // lacks its primary document, so it carries a missing-data gap too.
    await createExpense(
      ctx.db,
      makeExpenseInput({
        purchaseId: seeded.output.id,
        productId: item.id,
        cost: 400,
      }),
      ctx.actor,
    );

    const sorts = [{ orderBy: "date", direction: "desc" as const }];
    const complete = await purchaseList(
      ctx.db,
      { dataStatus: "complete" },
      sorts,
      page,
    );
    expect(complete.data.map((row) => row.id)).not.toContain(seeded.output.id);
    const defective = await purchaseList(
      ctx.db,
      { dataStatus: "defect" },
      sorts,
      page,
    );
    expect(defective.data.map((row) => row.id)).toContain(seeded.output.id);
  });
});
