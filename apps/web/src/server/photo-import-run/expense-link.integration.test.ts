import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import { generateShortcode } from "@cubby/shared";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  expense,
  run as runTable,
  photoGroupProposal,
  inventoryEntry,
  purchasePaymentEvidence,
  runFinding,
} from "~/server/db/schema";
import { memberImport } from "~/server/purchase-import/order-import.fixtures";
import {
  prepareSourceOrderReconciliation,
  commitAcceptedSourceOrderReconciliation,
} from "~/server/purchase-import/reconciliation";
import { getDb } from "~/server/repo/database-helpers";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { linkablePhotoGroupExpenses } from "./expense-link";

describe("photo review Expense link", () => {
  const ctx = withTestDb();

  it("reviews a live unlinked accepted line before linking the approved Product, with no extra money or stock on replay", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic reviewer",
      kind: "member" as const,
      userId: ctx.actor.userId,
    });
    const product = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic Canvas work boots size 7" }),
      ctx.actor,
    );
    const runId = parseEntityId("run", crypto.randomUUID());
    const [run] = await getDb(ctx.db)
      .insert(runTable)
      .values({
        id: runId,
        shortcode: generateShortcode("run"),
        ledgerPartyId: party.id,
        actorUserId: ctx.actor.userId,
        actorName: "Synthetic reviewer",
        actorEmail: "review@example.com",
        actorLedgerPartyShortcode: party.shortcode,
        actorLedgerPartyName: party.name,
        actorLedgerPartyKind: "member",
        agentSessionId: `photo-link-test:${runId}`,
        purpose: "photo_inventory",
        trigger: "manual",
        status: "completed",
      })
      .returning();
    await getDb(ctx.db).insert(photoGroupProposal).values({
      runId,
      groupKey: "boots",
      state: "committed",
      productKind: "existing",
      productId: product.entityId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic boot retailer",
    });
    await memberImport(ctx.db, ctx.actor, {
      key: "synthetic-photo-link",
      orders: [
        {
          stableOrderId: "synthetic-photo-link",
          vendorId: vendor.shortcode,
          source: {
            kind: "receipt_photo",
            externalKey: "synthetic:photo-link",
            checksum: "b".repeat(64),
          },
          extraction: {
            status: "ready",
            candidate: {
              orderId: "SYNTHETIC-BOOT-ORDER",
              orderedAt: "2026-01-05T12:00:00Z",
              merchant: "Synthetic boot retailer",
              currency: "USD",
              printedGrandTotal: 120,
              lines: [
                {
                  title: product.name,
                  amount: 120,
                  quantity: 1,
                  lineKind: "principal",
                },
              ],
              payments: [{ amount: 120 }],
              allShipmentsDelivered: true,
            },
          },
        },
      ],
    });
    const db = getDb(ctx.db);
    const line = await db.query.expense.findFirst();
    const association = await db.query.importSourceOrder.findFirst();
    if (!run || !line || !association?.acceptedObservationId)
      throw new Error("Known source line missing");
    const candidates = await linkablePhotoGroupExpenses(
      ctx.db,
      {
        runId: run.shortcode,
        groupKey: "boots",
      },
      ctx.actor,
    );
    expect(candidates.lines).toContainEqual(
      expect.objectContaining({
        expenseId: line.shortcode,
        acceptedSourceLines: [{ sourceOrderId: association.id, lineIndex: 0 }],
      }),
    );
    const snapshot = async () => ({
      expenses: await db.select().from(expense),
      stock: await db.select().from(inventoryEntry),
      payments: await db.select().from(purchasePaymentEvidence),
      findings: await db.select().from(runFinding),
    });
    const before = await snapshot();
    const review = await prepareSourceOrderReconciliation(
      ctx.db,
      {
        sourceOrderId: association.id,
        resolution: {
          kind: "attach_only",
          lines: [
            {
              lineIndex: 0,
              expenseId: parseShortcodeFor("expense", line.shortcode),
              productId: product.id,
            },
          ],
        },
      },
      ctx.actor,
    );
    expect(review.spend).toEqual({ before: 120, after: 120, delta: 0 });
    expect(await snapshot()).toEqual(before);
    await commitAcceptedSourceOrderReconciliation(
      ctx.db,
      { sourceOrderId: association.id, resolution: review.resolution },
      ctx.actor,
    );
    const [after] = await getDb(ctx.db)
      .select({
        productId: expense.productId,
        cost: expense.cost,
        productQuantity: expense.productQuantity,
      })
      .from(expense)
      .where(eq(expense.id, line.id));
    expect(after).toEqual({
      productId: product.entityId,
      cost: 120,
      productQuantity: 1,
    });
    const committed = await snapshot();
    expect(committed.stock).toEqual(before.stock);
    expect(committed.payments).toEqual(before.payments);
    expect(committed.findings).toEqual(before.findings);
    expect(committed.expenses).toHaveLength(1);
    expect(
      (
        await commitAcceptedSourceOrderReconciliation(
          ctx.db,
          { sourceOrderId: association.id, resolution: review.resolution },
          ctx.actor,
        )
      ).alreadyApplied,
    ).toBe(true);
    expect(await snapshot()).toEqual(committed);
  });
});
