import type { ProductId } from "@cubby/schemas/identifiers";
import { commitPurchaseImportInput } from "@cubby/schemas/purchase-import";
import { and, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  entityExternalId,
  externalSource,
  expense,
  product,
  productMatchCandidate,
  purchase,
} from "~/server/db/schema";
import { getDb, withTransaction } from "~/server/repo/database-helpers";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { commitPurchaseImport, preparePurchaseImport } from "./import-orders";
import { startOrResumeRun } from "./run-service";

const checksum = (digit: string) => digit.repeat(64);

describe("purchase import identifier collisions", () => {
  const ctx = withTestDb();

  async function shortcodeOf(productId: ProductId) {
    const [row] = await getDb(ctx.db)
      .select({ shortcode: product.shortcode })
      .from(product)
      .where(eq(product.id, productId));
    if (!row) throw new Error("Product fixture was not created");
    return row.shortcode;
  }

  it("keeps the reviewed Product, leaves the identifier with its owner, and proposes the pair for review", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Collision import member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Collision import Amazon fixture",
      website: "https://www.amazon.com/orders",
      browserDomains: ["amazon.com", "www.amazon.com"],
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Collision fixture account",
      vendorId: vendor.id,
      ledgerPartyId: party.id,
    });
    const owner = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "ForgeWear trail shirt, blue, medium" }),
      ctx.actor,
    );
    const reviewed = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "ForgeWear trail shirt, blue, large" }),
      ctx.actor,
    );
    await withTransaction(ctx.db, async (tx) => {
      await tx.insert(externalSource).values({
        slug: "amazon",
        label: "Example registered catalog",
        vendorId: vendor.id,
      });
      await tx.insert(entityExternalId).values({
        entityId: owner.entityId,
        entityKind: "product" as const,
        source: "amazon",
        kind: "asin",
        externalId: "B0COLLIDE1",
        isPrimary: true,
      });
    });
    const reviewedShortcode = await shortcodeOf(reviewed.entityId);
    const run = await startOrResumeRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });

    const prepareInput = {
      _runExecution: {
        runId: run.id,
        operationId: "prepare:collision-order",
        itemOperationIds: ["prepare-item:collision-order"],
      },
      orders: [
        {
          stableOrderId: "collision-order",
          itemOperationId: "prepare-item:collision-order",
          source: {
            kind: "browser_order" as const,
            externalKey: "amazon:order:111-0000000-4444444",
            checksum: checksum("c"),
          },
          evidenceChecksum: checksum("d"),
          extractionRevision: "amazon@fixture-1",
          extraction: {
            status: "ready" as const,
            candidate: {
              orderId: "111-0000000-4444444",
              orderedAt: "2026-09-20T12:00:00.000Z",
              merchant: "Amazon",
              currency: "USD",
              printedGrandTotal: 24.5,
              lines: [
                {
                  title: "ForgeWear trail shirt, blue, large",
                  amount: 24.5,
                  lineKind: "principal" as const,
                  sku: "FW-TRAIL-BLU-L",
                  productUrl: "https://www.amazon.com/dp/B0COLLIDE1",
                },
              ],
              payments: [],
              allShipmentsDelivered: false,
            },
          },
          lineIds: ["collision-order:line-1"],
          primaryDocumentImageId: null,
          screenshotImageId: null,
        },
      ],
    };
    await preparePurchaseImport(ctx.db, prepareInput, ctx.actor);

    const commitInput = commitPurchaseImportInput.parse({
      _runExecution: { runId: run.id, operationId: "commit:collision-order" },
      prepareOperationId: prepareInput._runExecution.operationId,
      defaultTrade: "other",
      resolutions: [
        {
          stableOrderId: "collision-order",
          stableLineId: "collision-order:line-1",
          resolution: {
            kind: "existing" as const,
            productId: reviewedShortcode,
          },
        },
      ],
    });
    const first = await commitPurchaseImport(ctx.db, commitInput, ctx.actor);
    expect(await commitPurchaseImport(ctx.db, commitInput, ctx.actor)).toEqual(
      first,
    );

    const [written] = await getDb(ctx.db)
      .select({ id: purchase.id })
      .from(purchase)
      .where(eq(purchase.orderId, "111-0000000-4444444"));
    expect(written).toBeDefined();
    expect(
      await getDb(ctx.db)
        .select({ productId: expense.productId })
        .from(expense)
        .where(eq(expense.purchaseId, written!.id)),
    ).toEqual([{ productId: reviewed.entityId }]);

    // The colliding ASIN is never reassigned; the line's own SKU is learned.
    const identifiers = await getDb(ctx.db)
      .select({
        entityId: entityExternalId.entityId,
        kind: entityExternalId.kind,
        externalId: entityExternalId.externalId,
      })
      .from(entityExternalId);
    expect(identifiers).toEqual(
      expect.arrayContaining([
        { entityId: owner.entityId, kind: "asin", externalId: "B0COLLIDE1" },
        {
          entityId: reviewed.entityId,
          kind: "retailer_sku",
          externalId: "FW-TRAIL-BLU-L",
        },
      ]),
    );
    expect(
      identifiers.filter((row) => row.externalId === "B0COLLIDE1"),
    ).toHaveLength(1);

    const proposals = await getDb(ctx.db)
      .select({
        state: productMatchCandidate.state,
        evidence: productMatchCandidate.evidence,
      })
      .from(productMatchCandidate)
      .where(
        and(
          eq(
            productMatchCandidate.productAId,
            owner.entityId < reviewed.entityId
              ? owner.entityId
              : reviewed.entityId,
          ),
          eq(
            productMatchCandidate.productBId,
            owner.entityId < reviewed.entityId
              ? reviewed.entityId
              : owner.entityId,
          ),
        ),
      );
    expect(proposals).toEqual([
      { state: "open", evidence: expect.stringContaining("B0COLLIDE1") },
    ]);
  });
});
