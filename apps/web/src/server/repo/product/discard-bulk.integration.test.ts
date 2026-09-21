import type { InventoryId } from "@cubby/schemas/identifiers";
import { eq, inArray } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { expense, inventoryEntry } from "~/server/db/schema";

import { getDb } from "../database-helpers";
import {
  createInventoryFixture as createInventoryEntry,
  createLocationFixture as createLocation,
  createProductFixture as createProduct,
  makeLocationInput,
  makeProductInput,
} from "../repo.fixtures";
import { discardFromInventoryEntries } from "./discard";

/**
 * The bulk seam only. Everything a single line does — the $0 cost, the negative
 * `productQuantity`, the absent Purchase, the cascade when an entry empties —
 * is `writeDiscardLine`, and `discard.integration.test.ts` covers it. What is
 * new here is what N rows under one transaction adds: a line per row, a
 * draw-down per row, and the two refusals that have no single-row counterpart.
 */
describe("discardFromInventoryEntries", () => {
  const ctx = withTestDb();

  // Location names and (name, manufacturer) product pairs are both globally
  // unique, and the test DB persists across the `it` blocks in this file — so
  // every seed mints its own shelf and its own product.
  let seedCounter = 0;
  const seedStockedProduct = async (amount: number) => {
    seedCounter += 1;
    const loc = await createLocation(
      ctx.db,
      makeLocationInput({ name: `Bulk scrap bin ${seedCounter}` }),
      ctx.actor,
    );
    const prod = await createProduct(
      ctx.db,
      makeProductInput({ name: `Bulk Kahuna ${seedCounter}`, price: 165 }),
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

  const loadEntry = async (id: InventoryId) =>
    getDb(ctx.db).query.inventoryEntry.findFirst({
      where: eq(inventoryEntry.id, id),
    });

  it.each(["2026-06-03", null])(
    "writes ledger lines with date %s and draws down each entry atomically",
    async (date) => {
      // One partial and one full in the same call: the full row is the case the
      // shelf row does not survive, and both must land under one transaction.
      const partial = await seedStockedProduct(5);
      const full = await seedStockedProduct(2);

      const result = await discardFromInventoryEntries(
        ctx.db,
        {
          items: [
            { inventoryEntryId: partial.entry.entityId, quantity: 2 },
            { inventoryEntryId: full.entry.entityId, quantity: 2 },
          ],
          date,
          trade: "other",
          reason: "Water damage",
        },
        ctx.actor,
      );

      expect(result.items).toHaveLength(2);

      const lines = await getDb(ctx.db).query.expense.findMany({
        where: inArray(
          expense.id,
          result.items.map((item) => item.expenseId),
        ),
      });
      expect(lines).toHaveLength(2);
      for (const line of lines) {
        expect(line).toMatchObject({
          cost: 0,
          date,
          productQuantity: -2,
          purchaseId: null,
          notes: "Water damage",
        });
      }
      // Two products, two lines — not one line carrying the whole selection.
      expect(new Set(lines.map((line) => line.productId)).size).toBe(2);

      expect(result.items[0]).toMatchObject({
        storedQuantity: -2,
        inventory: { removed: false, remainingValue: 3 },
      });
      expect((await loadEntry(partial.entry.entityId))?.amount.value).toBe(3);

      // Emptied, so soft-deleted rather than left claiming zero stock.
      expect(result.items[1]).toMatchObject({
        storedQuantity: -2,
        inventory: { removed: true, remainingValue: null },
      });
      expect((await loadEntry(full.entry.entityId))?.deletedAt).not.toBeNull();
    },
  );

  it("refuses more than a row holds, and writes nothing at all", async () => {
    // The deliberate divergence from the single-row path, which ALLOWS
    // over-discard because the shelf is a stale-tolerant estimate. A bulk
    // selection has no per-row operator attention, so a number above what the
    // row displays is refused — and, because the whole request is one
    // transaction, the legal row ahead of it is not written either.
    const ok = await seedStockedProduct(4);
    const tooMuch = await seedStockedProduct(1);

    await expect(
      discardFromInventoryEntries(
        ctx.db,
        {
          items: [
            { inventoryEntryId: ok.entry.entityId, quantity: 1 },
            { inventoryEntryId: tooMuch.entry.entityId, quantity: 3 },
          ],
          date: "2026-06-03",
          trade: "other",
          reason: null,
        },
        ctx.actor,
      ),
    ).rejects.toThrow(/holds 1/);

    expect((await loadEntry(ok.entry.entityId))?.amount.value).toBe(4);
    const written = await getDb(ctx.db).query.expense.findMany({
      where: eq(expense.productId, ok.prod.entityId),
    });
    expect(written).toHaveLength(0);
  });

  it("refuses the same entry listed twice", async () => {
    // Both lines would validate against the amount as it stood before either
    // was applied, so the second would draw down stock the first already took.
    const { entry } = await seedStockedProduct(5);

    await expect(
      discardFromInventoryEntries(
        ctx.db,
        {
          items: [
            { inventoryEntryId: entry.entityId, quantity: 3 },
            { inventoryEntryId: entry.entityId, quantity: 3 },
          ],
          date: "2026-06-03",
          trade: "other",
          reason: null,
        },
        ctx.actor,
      ),
    ).rejects.toThrow(/more than once/);

    expect((await loadEntry(entry.entityId))?.amount.value).toBe(5);
  });
});
