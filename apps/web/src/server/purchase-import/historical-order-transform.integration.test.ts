import { eq } from "drizzle-orm";
import { promoteHistoricalAcceptedOrders } from "tooling/historical-accepted-orders";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { importSourceOrder, inventoryEntry } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import {
  createInventoryFixture,
  createLocationFixture,
  createProductFixture,
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { memberImport } from "./order-import.fixtures";

// The deployment transform must preserve the real ledger and stock, skip
// unverifiable originals and converge without changing accepted snapshots.
describe("historical accepted-order deployment transform", () => {
  const ctx = withTestDb();
  it("promotes only verifiable originals without changing money or stock and repeats with zero promotions", async () => {
    await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic historical member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const seller = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic historical workshop",
    });
    await memberImport(ctx.db, ctx.actor, {
      key: "synthetic-historical-transform",
      orders: ["known", "unknown"].map((key) => ({
        stableOrderId: key,
        vendorId: seller.shortcode,
        source: {
          kind: "vendor_export",
          externalKey: `synthetic:historical:${key}`,
          checksum: (key === "known" ? "a" : "b").repeat(64),
        },
        extraction: {
          status: "ready",
          candidate: {
            orderId: `SYNTHETIC-${key}`,
            orderedAt: "2026-09-01T18:00:00Z",
            merchant: seller.name,
            currency: "USD",
            printedGrandTotal: 40,
            lines: [
              {
                title: "Workshop admission",
                amount: 40,
                lineKind: "principal",
              },
            ],
            payments: [{ amount: 40, chargedAt: "2026-09-01T18:00:00Z" }],
            allShipmentsDelivered: false,
          },
        },
      })),
    });
    const database = getDb(ctx.db);
    const orders = await database.select().from(importSourceOrder);
    const known = orders.find((row) => row.checksum === "a".repeat(64));
    const unknown = orders.find((row) => row.checksum === "b".repeat(64));
    if (!known || !unknown)
      throw new Error("Synthetic accepted orders unavailable");
    await database
      .update(importSourceOrder)
      .set({ acceptedObservationId: null })
      .where(eq(importSourceOrder.id, known.id));
    await database
      .update(importSourceOrder)
      .set({ acceptedObservationId: null, originalOrder: null })
      .where(eq(importSourceOrder.id, unknown.id));
    const sku = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic retained stock" }),
      ctx.actor,
    );
    const shelf = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Synthetic shelf", type: "shelf" }),
      ctx.actor,
    );
    await createInventoryFixture(
      ctx.db,
      {
        productId: sku.id,
        locationId: shelf.id,
        amount: { value: 3, unit: "each" },
      },
      ctx.actor,
    );
    const stock = await database.select().from(inventoryEntry);
    expect(await promoteHistoricalAcceptedOrders(ctx.db)).toMatchObject({
      scanned: 2,
      promoted: 1,
      alreadyKnown: 0,
      unknown: 1,
      refused: 0,
      financialUnchanged: true,
    });
    const [accepted] = await database
      .select()
      .from(importSourceOrder)
      .where(eq(importSourceOrder.id, known.id));
    expect(accepted).toMatchObject({
      originalOrder: known.originalOrder,
      checksum: known.checksum,
      outputFingerprint: known.outputFingerprint,
      acceptedObservationId: known.acceptedObservationId,
    });
    expect(await database.select().from(inventoryEntry)).toEqual(stock);
    expect(await promoteHistoricalAcceptedOrders(ctx.db)).toMatchObject({
      scanned: 2,
      promoted: 0,
      alreadyKnown: 1,
      unknown: 1,
      financialUnchanged: true,
    });
  });
});
