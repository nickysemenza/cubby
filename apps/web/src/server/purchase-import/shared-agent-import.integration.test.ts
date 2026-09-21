import {
  commitPurchaseImportInput,
  validatePurchaseImportInput,
} from "@cubby/schemas/purchase-import";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  expense,
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

    const commitInput = commitPurchaseImportInput.parse({
      ...missingDefaultsInput,
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
});
