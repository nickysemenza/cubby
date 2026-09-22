import {
  commitPurchaseImportInput,
  validatePurchaseImportInput,
} from "@cubby/schemas/purchase-import";
import { and, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  expense,
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
    const prepareInput = {
      _runExecution: {
        runPublicId: run.publicId,
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
              payments: [],
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
        runPublicId: run.publicId,
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
            runPublicId: started.run.publicId,
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
            runPublicId: started.run.publicId,
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
        runPublicId: run.publicId,
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
        runPublicId: run.publicId,
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
        runPublicId: run.publicId,
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
      _runExecution: { runPublicId: run.publicId, operationId },
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
});
