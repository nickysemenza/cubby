import { commitPurchaseImportInput } from "@cubby/schemas/purchase-import";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  expense,
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

import { commitPurchaseImport, preparePurchaseImport } from "./import-orders";
import { startOrResumeImportRun } from "./run-service";

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

    const commitInput = commitPurchaseImportInput.parse({
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
});
