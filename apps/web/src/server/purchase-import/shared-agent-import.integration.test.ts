import {
  commitPurchaseImportInput,
  validatePurchaseImportInput,
} from "@cubby/schemas/purchase-import";
import { and, eq, isNull } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  expense,
  financialTransactionAllocation,
  importFinding,
  importRunOperation,
  importRunTarget,
  product,
  productExternalId,
  purchase,
} from "~/server/db/schema";
import { getDb, withTransaction } from "~/server/repo/database-helpers";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import {
  commitPurchaseImport,
  preparePurchaseImport,
  validatePurchaseImport,
} from "./import-orders";
import { startOrResumeImportRun, startTargetedImportRun } from "./run-service";

const checksum = (digit: string) => digit.repeat(64);

describe("shared purchase-import prepare and commit", () => {
  const ctx = withTestDb();

  it("reuses an exact ASIN and replays the committed business result", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Shared import member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Shared import Amazon fixture",
      website: "https://www.amazon.com/orders",
      browserDomains: ["amazon.com", "www.amazon.com"],
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Shared import fixture account",
      vendorId: vendor.id,
      ledgerPartyId: party.id,
    });
    const existingProduct = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Reusable exact-ASIN product" }),
      ctx.actor,
    );
    const [existingProductRow] = await getDb(ctx.db)
      .select({ shortcode: product.shortcode })
      .from(product)
      .where(eq(product.id, existingProduct.entityId));
    if (!existingProductRow) throw new Error("Product fixture was not created");
    await withTransaction(ctx.db, async (tx) => {
      await tx.insert(productExternalId).values({
        productId: existingProduct.entityId,
        source: "amazon",
        kind: "asin",
        externalId: "B012345678",
        isPrimary: true,
      });
    });
    const run = await startOrResumeImportRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    const financialAccount = await insertWithShortcode(
      ctx.db,
      "financialAccount",
      {
        name: "Shared import fixture card",
        identity: { kind: "credit_card", issuer: null, network: "visa" },
        ledgerPartyId: party.id,
      },
    );
    const postedCharge = await insertWithShortcode(
      ctx.db,
      "financialTransaction",
      {
        accountId: financialAccount.id,
        kind: "purchase",
        status: "posted",
        amount: 12.34,
        transactionDate: null,
        postedDate: "2026-09-21",
      },
    );
    const prepareInput = {
      _runExecution: {
        runId: run.id,
        operationId: "prepare:amazon-order-1",
        itemOperationIds: ["prepare-item:amazon-order-1"],
      },
      orders: [
        {
          stableOrderId: "amazon-order-1",
          itemOperationId: "prepare-item:amazon-order-1",
          source: {
            kind: "browser_order" as const,
            externalKey: "amazon:order:111-2222222-3333333",
            checksum: checksum("a"),
          },
          evidenceChecksum: checksum("b"),
          extractionRevision: "amazon@fixture-1",
          extraction: {
            status: "ready" as const,
            candidate: {
              orderId: "111-2222222-3333333",
              orderedAt: "2026-09-20T12:00:00.000Z",
              merchant: "Amazon",
              currency: "USD",
              printedGrandTotal: 12.34,
              lines: [
                {
                  title: "Reusable exact-ASIN product",
                  amount: 12.34,
                  lineKind: "principal" as const,
                  productUrl:
                    "https://www.amazon.com/dp/B012345678?ref_=orders",
                },
              ],
              payments: [
                { amount: 12.34, chargedAt: "2026-09-20T12:00:00.000Z" },
              ],
              allShipmentsDelivered: false,
            },
          },
          lineIds: ["amazon-order-1:line-1"],
          primaryDocumentImageId: null,
          screenshotImageId: null,
        },
      ],
    };

    const prepared = await preparePurchaseImport(
      ctx.db,
      prepareInput,
      ctx.actor,
    );
    expect(prepared.status).toBe("running");
    expect(prepared.orders[0]?.lines[0]?.candidates[0]).toMatchObject({
      productId: existingProductRow.shortcode,
      exactIdentifierMatch: true,
    });

    const missingDefaultsInput = commitPurchaseImportInput.parse({
      _runExecution: {
        runId: run.id,
        operationId: "commit:amazon-order-1",
      },
      prepareOperationId: prepareInput._runExecution.operationId,
      resolutions: [
        {
          stableOrderId: "amazon-order-1",
          stableLineId: "amazon-order-1:line-1",
          resolution: {
            kind: "existing" as const,
            productId: existingProductRow.shortcode,
          },
        },
      ],
    });
    await expect(
      commitPurchaseImport(ctx.db, missingDefaultsInput, ctx.actor),
    ).rejects.toMatchObject({
      reason: "CONSTRAINT_VIOLATION",
      message:
        "A principal Expense requires a trade from the Expense, its Purchase, or its effective Project.",
    });
    expect(
      await getDb(ctx.db)
        .select({ id: purchase.id })
        .from(purchase)
        .where(eq(purchase.orderId, "111-2222222-3333333")),
    ).toHaveLength(0);

    // A fresh operationId for the corrected retry: the failed attempt above
    // now leaves its own `failed` ImportRunOperation row (see the dedicated
    // failure test below), so replaying "commit:amazon-order-1" with
    // different args is a fenced conflict, not a retry.
    const commitInput = commitPurchaseImportInput.parse({
      ...missingDefaultsInput,
      _runExecution: {
        ...missingDefaultsInput._runExecution,
        operationId: "commit:amazon-order-1-retry",
      },
      defaultTrade: "other",
    });
    const first = await commitPurchaseImport(ctx.db, commitInput, ctx.actor);
    const replay = await commitPurchaseImport(ctx.db, commitInput, ctx.actor);
    expect(replay).toEqual(first);

    const writtenPurchases = await getDb(ctx.db)
      .select({ id: purchase.id })
      .from(purchase)
      .where(eq(purchase.orderId, "111-2222222-3333333"));
    expect(writtenPurchases).toHaveLength(1);
    const writtenExpenses = await getDb(ctx.db)
      .select({ productId: expense.productId })
      .from(expense)
      .where(eq(expense.purchaseId, writtenPurchases[0]!.id));
    expect(writtenExpenses).toEqual([{ productId: existingProduct.entityId }]);
    const allocations = await getDb(ctx.db)
      .select({ transactionId: financialTransactionAllocation.transactionId })
      .from(financialTransactionAllocation)
      .where(
        eq(financialTransactionAllocation.purchaseId, writtenPurchases[0]!.id),
      );
    expect(allocations).toEqual([{ transactionId: postedCharge.id }]);
  });

  it("matches a photo-recorded barcode exactly when the order line SKU is that UPC", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Barcode import member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Barcode import vendor fixture",
      website: "https://shop.example.com/orders",
      browserDomains: ["shop.example.com"],
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Barcode import fixture account",
      vendorId: vendor.id,
      ledgerPartyId: party.id,
    });
    // A photo-first Product whose only identifier is the barcode read off its
    // tag, stored under the vendor-neutral GTIN source.
    const photoProduct = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Gray crew t-shirt — M" }),
      ctx.actor,
    );
    const [photoProductRow] = await getDb(ctx.db)
      .select({ shortcode: product.shortcode })
      .from(product)
      .where(eq(product.id, photoProduct.entityId));
    if (!photoProductRow) throw new Error("Product fixture was not created");
    await withTransaction(ctx.db, async (tx) => {
      await tx.insert(productExternalId).values({
        productId: photoProduct.entityId,
        source: "gtin",
        kind: "gtin_14",
        externalId: "00012345678905",
        isPrimary: true,
      });
    });
    const run = await startOrResumeImportRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });

    const prepared = await preparePurchaseImport(
      ctx.db,
      {
        _runExecution: {
          runId: run.id,
          operationId: "prepare:barcode-order-1",
          itemOperationIds: ["prepare-item:barcode-order-1"],
        },
        orders: [
          {
            stableOrderId: "barcode-order-1",
            itemOperationId: "prepare-item:barcode-order-1",
            source: {
              kind: "browser_order" as const,
              externalKey: "example:order:barcode-1",
              checksum: checksum("c"),
            },
            evidenceChecksum: checksum("d"),
            extractionRevision: "example@fixture-1",
            extraction: {
              status: "ready" as const,
              candidate: {
                orderId: "barcode-1",
                orderedAt: "2026-09-20T12:00:00.000Z",
                merchant: "Example Shop",
                currency: "USD",
                printedGrandTotal: 20,
                lines: [
                  {
                    title: "Everyday Crew Tee Heather Gray",
                    amount: 20,
                    lineKind: "principal" as const,
                    sku: "012345678905",
                  },
                ],
                payments: [],
                allShipmentsDelivered: false,
              },
            },
            lineIds: ["barcode-order-1:line-1"],
            primaryDocumentImageId: null,
            screenshotImageId: null,
          },
        ],
      },
      ctx.actor,
    );
    expect(prepared.orders[0]?.lines[0]?.candidates[0]).toMatchObject({
      productId: photoProductRow.shortcode,
      exactIdentifierMatch: true,
    });
  });

  it("refuses foreign-currency semantic replay and distinguishes raw evidence drift", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Validation member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: `Validation vendor ${crypto.randomUUID()}`,
      website: "https://shop.example.test",
      browserDomains: ["shop.example.test"],
    });
    const existingProduct = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Validation product" }),
      ctx.actor,
    );
    const [productRow] = await getDb(ctx.db)
      .select({ shortcode: product.shortcode })
      .from(product)
      .where(eq(product.id, existingProduct.entityId));
    if (!productRow) throw new Error("Product fixture was not created");
    const existingPurchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      orderId: "ORDER-VALIDATE-1",
      date: "2026-09-20",
      statedTotal: 12.34,
    });
    await insertWithShortcode(ctx.db, "expense", {
      purchaseId: existingPurchase.id,
      name: "Validation product",
      cost: 12.34,
      date: "2026-09-20",
      lineKind: "principal",
      costType: "materials",
      trade: "other",
      future: false,
      productId: existingProduct.entityId,
      productQuantity: 1,
    });

    const runValidation = async (
      currency: "USD" | "EUR",
      sourceChecksum: string,
    ) => {
      const started = await startTargetedImportRun(ctx.db, {
        ledgerPartyId: party.id,
        purpose: "purchase_validation",
        vendorId: vendor.id,
        vendorAccountId: null,
        trigger: "manual",
        targets: [
          {
            kind: "purchase",
            purchaseId: existingPurchase.id,
            sourceKind: "browser_order",
            sourceExternalKey: "validation:ORDER-VALIDATE-1",
            targetFingerprint: checksum("c"),
            evidenceFingerprint: checksum("a"),
          },
        ],
      });
      if (!started.created) throw new Error("Validation run was blocked");
      const prepareOperationId = `prepare:${currency.toLowerCase()}`;
      await preparePurchaseImport(
        ctx.db,
        {
          _runExecution: {
            runId: started.run.id,
            operationId: prepareOperationId,
            itemOperationIds: [`item:${currency.toLowerCase()}`],
          },
          orders: [
            {
              stableOrderId: `order-${currency.toLowerCase()}`,
              itemOperationId: `item:${currency.toLowerCase()}`,
              source: {
                kind: "browser_order",
                externalKey: "validation:ORDER-VALIDATE-1",
                checksum: sourceChecksum,
              },
              evidenceChecksum: checksum("b"),
              extractionRevision: "validation@1",
              extraction: {
                status: "ready",
                candidate: {
                  orderId: "ORDER-VALIDATE-1",
                  orderedAt: "2026-09-20T12:00:00.000Z",
                  merchant: "Example",
                  currency,
                  printedGrandTotal: 12.34,
                  lines: [
                    {
                      title: "Validation product",
                      amount: 12.34,
                      lineKind: "principal",
                      quantity: 1,
                    },
                  ],
                  payments: [],
                  allShipmentsDelivered: true,
                },
              },
              lineIds: [`line-${currency.toLowerCase()}`],
              primaryDocumentImageId: null,
              screenshotImageId: null,
            },
          ],
        },
        ctx.actor,
      );
      const result = await validatePurchaseImport(
        ctx.db,
        validatePurchaseImportInput.parse({
          _runExecution: {
            runId: started.run.id,
            operationId: `validate:${currency.toLowerCase()}`,
          },
          prepareOperationId,
          resolutions: [
            {
              stableOrderId: `order-${currency.toLowerCase()}`,
              stableLineId: `line-${currency.toLowerCase()}`,
              resolution: { kind: "existing", productId: productRow.shortcode },
            },
          ],
        }),
        ctx.actor,
      );
      const [target] = await getDb(ctx.db)
        .select({ warning: importRunTarget.warning })
        .from(importRunTarget)
        .where(eq(importRunTarget.runId, started.run.id));
      return { result, target };
    };

    const foreign = await runValidation("EUR", checksum("a"));
    expect(foreign.result).toMatchObject({
      status: "needs_review",
      targets: [{ outcome: "semantic_drift" }],
    });

    const rawDrift = await runValidation("USD", checksum("d"));
    expect(rawDrift.result).toMatchObject({
      status: "completed",
      targets: [{ outcome: "raw_evidence_drift", diff: null }],
    });
    expect(rawDrift.target?.warning).toContain("source evidence changed");
  });

  it("commits tax and shipping lines using only the principal line's resolution", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Adjustment lines member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: `Adjustment lines vendor ${crypto.randomUUID()}`,
      website: "https://shop.example.test",
      browserDomains: ["shop.example.test"],
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Adjustment lines account",
      vendorId: vendor.id,
      ledgerPartyId: party.id,
    });
    const existingProduct = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Adjustment lines widget" }),
      ctx.actor,
    );
    const [productRow] = await getDb(ctx.db)
      .select({ shortcode: product.shortcode })
      .from(product)
      .where(eq(product.id, existingProduct.entityId));
    if (!productRow) throw new Error("Product fixture was not created");

    const run = await startOrResumeImportRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    const prepareInput = {
      _runExecution: {
        runId: run.id,
        operationId: "prepare:adjustments-order-1",
        itemOperationIds: ["prepare-item:adjustments-order-1"],
      },
      orders: [
        {
          stableOrderId: "adjustments-order-1",
          itemOperationId: "prepare-item:adjustments-order-1",
          source: {
            kind: "browser_order" as const,
            externalKey: "adjustments:order:1",
            checksum: checksum("e"),
          },
          evidenceChecksum: checksum("f"),
          extractionRevision: "adjustments@fixture-1",
          extraction: {
            status: "ready" as const,
            candidate: {
              orderId: "ADJUSTMENTS-ORDER-1",
              orderedAt: "2026-09-20T12:00:00.000Z",
              merchant: "Example",
              currency: "USD",
              printedGrandTotal: 25,
              lines: [
                {
                  title: "Adjustment lines widget",
                  amount: 20,
                  lineKind: "principal" as const,
                },
                { title: "Sales tax", amount: 2, lineKind: "tax" as const },
                {
                  title: "Shipping",
                  amount: 3,
                  lineKind: "shipping" as const,
                },
              ],
              payments: [],
              allShipmentsDelivered: false,
            },
          },
          lineIds: [
            "adjustments-order-1:line-1",
            "adjustments-order-1:line-2",
            "adjustments-order-1:line-3",
          ],
          primaryDocumentImageId: null,
          screenshotImageId: null,
        },
      ],
    };
    await preparePurchaseImport(ctx.db, prepareInput, ctx.actor);

    // Only the principal line carries a resolution — tax and shipping are
    // never resolvable to a Product, matching what the MCP layer sends.
    const commitInput = commitPurchaseImportInput.parse({
      _runExecution: {
        runId: run.id,
        operationId: "commit:adjustments-order-1",
      },
      prepareOperationId: prepareInput._runExecution.operationId,
      defaultTrade: "other" as const,
      resolutions: [
        {
          stableOrderId: "adjustments-order-1",
          stableLineId: "adjustments-order-1:line-1",
          resolution: {
            kind: "existing" as const,
            productId: productRow.shortcode,
          },
        },
      ],
    });

    const result = await commitPurchaseImport(ctx.db, commitInput, ctx.actor);
    expect(result.status).toBe("running");
    expect(result.items[0]?.purchaseId).not.toBeNull();

    const [written] = await getDb(ctx.db)
      .select({ id: purchase.id })
      .from(purchase)
      .where(eq(purchase.orderId, "ADJUSTMENTS-ORDER-1"));
    if (!written) throw new Error("Purchase was not written");
    const writtenExpenses = await getDb(ctx.db)
      .select({ lineKind: expense.lineKind, productId: expense.productId })
      .from(expense)
      .where(eq(expense.purchaseId, written.id));
    expect(writtenExpenses).toHaveLength(3);
    expect(
      writtenExpenses.find((row) => row.lineKind === "principal")?.productId,
    ).toBe(existingProduct.entityId);
    for (const kind of ["tax", "shipping"] as const) {
      expect(
        writtenExpenses.find((row) => row.lineKind === kind)?.productId,
      ).toBeNull();
    }
  });

  it("leaves a failed ImportRunOperation row when a resolution's product cannot be resolved", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Failed commit member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: `Failed commit vendor ${crypto.randomUUID()}`,
      website: "https://shop.example.test",
      browserDomains: ["shop.example.test"],
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Failed commit account",
      vendorId: vendor.id,
      ledgerPartyId: party.id,
    });
    const run = await startOrResumeImportRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    const prepareInput = {
      _runExecution: {
        runId: run.id,
        operationId: "prepare:failing-order-1",
        itemOperationIds: ["prepare-item:failing-order-1"],
      },
      orders: [
        {
          stableOrderId: "failing-order-1",
          itemOperationId: "prepare-item:failing-order-1",
          source: {
            kind: "browser_order" as const,
            externalKey: "failing:order:1",
            checksum: checksum("1"),
          },
          evidenceChecksum: checksum("2"),
          extractionRevision: "failing@fixture-1",
          extraction: {
            status: "ready" as const,
            candidate: {
              orderId: "FAILING-ORDER-1",
              orderedAt: "2026-09-20T12:00:00.000Z",
              merchant: "Example",
              currency: "USD",
              printedGrandTotal: 9.99,
              lines: [
                {
                  title: "Widget",
                  amount: 9.99,
                  lineKind: "principal" as const,
                },
              ],
              payments: [],
              allShipmentsDelivered: false,
            },
          },
          lineIds: ["failing-order-1:line-1"],
          primaryDocumentImageId: null,
          screenshotImageId: null,
        },
      ],
    };
    await preparePurchaseImport(ctx.db, prepareInput, ctx.actor);

    const operationId = "commit:failing-order-1";
    const commitInput = commitPurchaseImportInput.parse({
      _runExecution: { runId: run.id, operationId },
      prepareOperationId: prepareInput._runExecution.operationId,
      defaultTrade: "other" as const,
      resolutions: [
        {
          stableOrderId: "failing-order-1",
          stableLineId: "failing-order-1:line-1",
          // Well-formed shortcode for a Product that does not exist:
          // resolveOrThrow rejects deep inside the transaction, after the
          // ImportRunOperation "started" row has already been inserted, so
          // that insert is rolled back along with everything else.
          resolution: { kind: "existing" as const, productId: "PRD-9999" },
        },
      ],
    });

    await expect(
      commitPurchaseImport(ctx.db, commitInput, ctx.actor),
    ).rejects.toThrow("PRD-9999");

    const [operation] = await getDb(ctx.db)
      .select({
        state: importRunOperation.state,
        error: importRunOperation.error,
      })
      .from(importRunOperation)
      .where(
        and(
          eq(importRunOperation.runId, run.id),
          eq(importRunOperation.operationId, operationId),
        ),
      );
    expect(operation?.state).toBe("failed");
    expect(operation?.error).toContain("PRD-9999");
  });

  it("replaces a manually recorded Purchase's aggregate expense instead of duplicating it", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Manual-then-import member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: `Manual-then-import vendor ${crypto.randomUUID()}`,
      website: "https://shop.example.test",
      browserDomains: ["shop.example.test"],
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Manual-then-import account",
      vendorId: vendor.id,
      ledgerPartyId: party.id,
    });
    // A household member recorded this order by hand before any import ran:
    // one aggregate Expense, no Product, no source claim.
    const manualPurchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      orderId: "MANUAL-ORDER-1",
      date: "2026-09-18",
      statedTotal: 45,
    });
    const manualExpense = await insertWithShortcode(ctx.db, "expense", {
      purchaseId: manualPurchase.id,
      name: "Recorded from a paper receipt",
      cost: 45,
      date: "2026-09-18",
      lineKind: "principal",
      costType: "materials",
      trade: "other",
      future: false,
      productId: null,
      productQuantity: null,
    });
    const existingProduct = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Manual merge target product" }),
      ctx.actor,
    );
    const [productRow] = await getDb(ctx.db)
      .select({ shortcode: product.shortcode })
      .from(product)
      .where(eq(product.id, existingProduct.entityId));
    if (!productRow) throw new Error("Product fixture was not created");

    const run = await startOrResumeImportRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    const prepareInput = {
      _runExecution: {
        runId: run.id,
        operationId: "prepare:manual-order-1",
        itemOperationIds: ["prepare-item:manual-order-1"],
      },
      orders: [
        {
          stableOrderId: "manual-order-1",
          itemOperationId: "prepare-item:manual-order-1",
          source: {
            kind: "browser_order" as const,
            externalKey: "manual-then-import:order:1",
            checksum: checksum("5"),
          },
          evidenceChecksum: checksum("6"),
          extractionRevision: "manual-then-import@fixture-1",
          extraction: {
            status: "ready" as const,
            candidate: {
              orderId: "MANUAL-ORDER-1",
              orderedAt: "2026-09-18T12:00:00.000Z",
              merchant: "Example",
              currency: "USD",
              printedGrandTotal: 45,
              lines: [
                {
                  title: "Manual merge target product",
                  amount: 45,
                  lineKind: "principal" as const,
                },
              ],
              payments: [],
              allShipmentsDelivered: false,
            },
          },
          lineIds: ["manual-order-1:line-1"],
          primaryDocumentImageId: null,
          screenshotImageId: null,
        },
      ],
    };
    await preparePurchaseImport(ctx.db, prepareInput, ctx.actor);

    const commitInput = commitPurchaseImportInput.parse({
      _runExecution: { runId: run.id, operationId: "commit:manual-order-1" },
      prepareOperationId: prepareInput._runExecution.operationId,
      defaultTrade: "other" as const,
      resolutions: [
        {
          stableOrderId: "manual-order-1",
          stableLineId: "manual-order-1:line-1",
          resolution: {
            kind: "existing" as const,
            productId: productRow.shortcode,
          },
        },
      ],
    });
    const result = await commitPurchaseImport(ctx.db, commitInput, ctx.actor);
    // The order was already a Purchase (found by vendor + orderId), so this
    // is an update to it, never a second Purchase for the same order.
    expect(result.items[0]?.outcome).toBe("updated");
    expect(result.items[0]?.purchaseId).toBe(manualPurchase.shortcode);

    const purchasesForOrder = await getDb(ctx.db)
      .select({ id: purchase.id })
      .from(purchase)
      .where(eq(purchase.orderId, "MANUAL-ORDER-1"));
    expect(purchasesForOrder).toHaveLength(1);
    expect(purchasesForOrder[0]?.id).toBe(manualPurchase.id);

    const liveExpenses = await getDb(ctx.db)
      .select({
        id: expense.id,
        productId: expense.productId,
        cost: expense.cost,
      })
      .from(expense)
      .where(
        and(
          eq(expense.purchaseId, manualPurchase.id),
          isNull(expense.deletedAt),
        ),
      );
    // The import replaced the one legacy aggregate line with an
    // identified line rather than adding a second Expense beside it.
    expect(liveExpenses).toHaveLength(1);
    expect(liveExpenses[0]?.productId).toBe(existingProduct.entityId);
    expect(Number(liveExpenses[0]?.cost)).toBe(45);

    const [deletedManualExpense] = await getDb(ctx.db)
      .select({ deletedAt: expense.deletedAt })
      .from(expense)
      .where(eq(expense.id, manualExpense.id));
    expect(deletedManualExpense?.deletedAt).not.toBeNull();
  });

  it("files a conflict finding instead of duplicating a manual Purchase whose Expense is already identified", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Manual conflict member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: `Manual conflict vendor ${crypto.randomUUID()}`,
      website: "https://shop.example.test",
      browserDomains: ["shop.example.test"],
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Manual conflict account",
      vendorId: vendor.id,
      ledgerPartyId: party.id,
    });
    const existingProduct = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Already-identified manual product" }),
      ctx.actor,
    );
    // This member already fully recorded the order by hand: a Purchase, an
    // Expense, AND its Product — nothing here is a replaceable aggregate.
    const manualPurchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      orderId: "MANUAL-ORDER-2",
      date: "2026-09-19",
      statedTotal: 18,
    });
    const manualExpense = await insertWithShortcode(ctx.db, "expense", {
      purchaseId: manualPurchase.id,
      name: "Already-identified manual product",
      cost: 18,
      date: "2026-09-19",
      lineKind: "principal",
      costType: "materials",
      trade: "other",
      future: false,
      productId: existingProduct.entityId,
      productQuantity: 1,
    });

    const run = await startOrResumeImportRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    const prepareInput = {
      _runExecution: {
        runId: run.id,
        operationId: "prepare:manual-order-2",
        itemOperationIds: ["prepare-item:manual-order-2"],
      },
      orders: [
        {
          stableOrderId: "manual-order-2",
          itemOperationId: "prepare-item:manual-order-2",
          source: {
            kind: "browser_order" as const,
            externalKey: "manual-conflict:order:1",
            checksum: checksum("7"),
          },
          evidenceChecksum: checksum("8"),
          extractionRevision: "manual-conflict@fixture-1",
          extraction: {
            status: "ready" as const,
            candidate: {
              orderId: "MANUAL-ORDER-2",
              orderedAt: "2026-09-19T12:00:00.000Z",
              merchant: "Example",
              currency: "USD",
              printedGrandTotal: 18,
              lines: [
                {
                  title: "Already-identified manual product",
                  amount: 18,
                  lineKind: "principal" as const,
                },
              ],
              payments: [],
              allShipmentsDelivered: false,
            },
          },
          lineIds: ["manual-order-2:line-1"],
          primaryDocumentImageId: null,
          screenshotImageId: null,
        },
      ],
    };
    await preparePurchaseImport(ctx.db, prepareInput, ctx.actor);

    const commitInput = commitPurchaseImportInput.parse({
      _runExecution: { runId: run.id, operationId: "commit:manual-order-2" },
      prepareOperationId: prepareInput._runExecution.operationId,
      defaultTrade: "other" as const,
      resolutions: [
        {
          stableOrderId: "manual-order-2",
          stableLineId: "manual-order-2:line-1",
          resolution: {
            kind: "existing" as const,
            productId: (
              await getDb(ctx.db)
                .select({ shortcode: product.shortcode })
                .from(product)
                .where(eq(product.id, existingProduct.entityId))
            )[0]!.shortcode,
          },
        },
      ],
    });
    const result = await commitPurchaseImport(ctx.db, commitInput, ctx.actor);
    expect(result.items[0]?.outcome).toBe("updated");
    expect(result.items[0]?.findingCount).toBeGreaterThan(0);

    const purchasesForOrder = await getDb(ctx.db)
      .select({ id: purchase.id })
      .from(purchase)
      .where(eq(purchase.orderId, "MANUAL-ORDER-2"));
    expect(purchasesForOrder).toHaveLength(1);

    const liveExpenses = await getDb(ctx.db)
      .select({ id: expense.id })
      .from(expense)
      .where(
        and(
          eq(expense.purchaseId, manualPurchase.id),
          isNull(expense.deletedAt),
        ),
      );
    // No second Expense was created, and the original manual line survives
    // untouched.
    expect(liveExpenses).toEqual([{ id: manualExpense.id }]);

    const findings = await getDb(ctx.db)
      .select({ kind: importFinding.kind })
      .from(importFinding)
      .where(eq(importFinding.targetId, manualPurchase.id));
    expect(findings.some((row) => row.kind === "duplicate_lines")).toBe(true);
  });
});
