import { and, eq, isNull } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { entityEmbedding, expense, inventoryEntry } from "~/server/db/schema";

import { getDb } from "../database-helpers";
import {
  createInventoryFixture as createInventoryEntry,
  createLocationFixture as createLocation,
  createProductFixture as createProduct,
  makeLocationInput,
  makeProductInput,
} from "../repo.fixtures";
import { discardProductUnits } from "./discard";

describe("discardProductUnits", () => {
  const ctx = withTestDb();

  // Location names and (name, manufacturer) product pairs are both globally
  // unique, and the test DB persists across the `it` blocks in this file — so
  // every seed mints its own shelf and its own product.
  let seedCounter = 0;
  const seedStockedProduct = async (amount: number) => {
    seedCounter += 1;
    const loc = await createLocation(
      ctx.db,
      makeLocationInput({ name: `Scrap bin ${seedCounter}` }),
      ctx.actor,
    );
    const prod = await createProduct(
      ctx.db,
      makeProductInput({ name: `Kahuna Burner ${seedCounter}`, price: 165 }),
      ctx.actor,
    );
    const entry = await createInventoryEntry(
      ctx.db,
      {
        productId: prod.entityId,
        locationId: loc.entityId,
        amount: { value: amount, unit: "each" },
      },
      ctx.actor,
    );
    return { prod, entry };
  };

  const loadExpense = async (id: string) =>
    getDb(ctx.db).query.expense.findFirst({
      where: eq(expense.shortcode, id),
    });

  it.each(["2026-06-03", null])(
    "mints a $0 negative-quantity line with date %s and no vendor charge",
    async (date) => {
      const { prod } = await seedStockedProduct(3);

      const result = await discardProductUnits(
        ctx.db,
        {
          productId: prod.entityId,
          quantity: 1,
          date,
          trade: "other",
          reason: "Thrown away",
          inventoryEntryId: null,
        },
        ctx.actor,
      );

      const row = await loadExpense(result.expenseShortcode);
      expect(row).toMatchObject({
        cost: 0,
        date,
        productQuantity: -1,
        lineKind: "principal",
        // The whole point: a discard is not part of any order, so it must not
        // inherit a vendor or an order id from the purchase that bought the item.
        purchaseId: null,
        projectId: null,
        notes: "Thrown away",
        future: false,
      });
      expect(row?.name).toContain("Discarded");
      expect(result.storedQuantity).toBe(-1);
    },
  );

  it("decrements the named shelf when asked", async () => {
    const { prod, entry } = await seedStockedProduct(3);

    const result = await discardProductUnits(
      ctx.db,
      {
        productId: prod.entityId,
        quantity: 2,
        date: "2026-06-03",
        trade: "other",
        reason: null,
        inventoryEntryId: entry.entityId,
      },
      ctx.actor,
    );

    expect(result.inventory).toMatchObject({
      removed: false,
      remainingValue: 1,
    });
    const after = await getDb(ctx.db).query.inventoryEntry.findFirst({
      where: eq(inventoryEntry.id, entry.entityId),
    });
    expect(after?.amount.value).toBe(1);
    expect(after?.deletedAt).toBeNull();
  });

  // Over-discard is deliberately allowed rather than refused the way
  // bulkMoveInventoryEntries refuses an over-move — the shelf is a
  // stale-tolerant ballpark and the operator at the bin outranks it. See the
  // comment on the `remaining` branch in discard.ts. This pins that the
  // `remaining < 0` path empties the entry and keeps the stated quantity,
  // rather than clamping, throwing, or silently recording something else.

  it("empties the entry and cascades its embedding when nothing is left", async () => {
    const { prod, entry } = await seedStockedProduct(2);

    const result = await discardProductUnits(
      ctx.db,
      {
        productId: prod.entityId,
        quantity: 2,
        date: "2026-06-03",
        trade: "other",
        reason: null,
        inventoryEntryId: entry.entityId,
      },
      ctx.actor,
    );

    expect(result.inventory).toMatchObject({
      removed: true,
      remainingValue: null,
    });
    const after = await getDb(ctx.db).query.inventoryEntry.findFirst({
      where: eq(inventoryEntry.id, entry.entityId),
    });
    expect(after?.deletedAt).not.toBeNull();

    // The removal-path invariant: an entry that leaves must take its search
    // embedding with it, in the SAME transaction. Asserted as "no live row
    // remains" rather than "a soft-deleted row exists", so the test holds
    // whether or not an embedding had been generated yet.
    const live = await getDb(ctx.db)
      .select({ id: entityEmbedding.id })
      .from(entityEmbedding)
      .where(
        and(
          eq(entityEmbedding.entityType, "inventory"),
          eq(entityEmbedding.entityId, entry.entityId),
          isNull(entityEmbedding.deletedAt),
        ),
      );
    expect(live).toHaveLength(0);
  });

  it("refuses an entry that belongs to a different product", async () => {
    const { prod } = await seedStockedProduct(2);
    const other = await seedStockedProduct(2);

    await expect(
      discardProductUnits(
        ctx.db,
        {
          productId: prod.entityId,
          quantity: 1,
          date: "2026-06-03",
          trade: "other",
          reason: null,
          // Silently decrementing the shelf that WAS named would take units off
          // the wrong thing — the one failure mode worth being loud about.
          inventoryEntryId: other.entry.entityId,
        },
        ctx.actor,
      ),
      // oxlint-disable-next-line vitest/require-to-throw-message -- The rejection itself is contractual; the exact message is intentionally not.
    ).rejects.toThrow();
  });
});
