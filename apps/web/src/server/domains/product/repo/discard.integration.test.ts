import { and, eq, isNull } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { relationalSql } from "~/server/db/helpers/relational-sql";
import { entityEmbedding, expense, inventoryEntry } from "~/server/db/schema";
import {
  deleteExpenses,
  updateExpense,
} from "~/server/domains/expense/repo/crud";
import {
  bulkMoveInventoryEntries,
  reconcileLocationSession,
} from "~/server/domains/inventory/repo/bulk";
import { deleteInventoryEntries } from "~/server/domains/inventory/repo/crud";
import {
  createInventoryFixture as createInventoryEntry,
  createLocationFixture as createLocation,
  createProductFixture as createProduct,
  makeExpenseInput,
  makeLocationInput,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

import { discardProductUnits } from "./discard";
import { getProductWithFood } from "./write/product-writes";

describe("discardProductUnits", () => {
  const ctx = withTestDb();
  const food = { findFood: async () => null };

  // Location names and (name, brandName) product pairs are both globally
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
      where: {
        RAW: (table: PgTable) =>
          relationalSql(table, eq(expense.shortcode, id)),
      },
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
      where: {
        RAW: (table: PgTable) =>
          relationalSql(table, eq(inventoryEntry.id, entry.entityId)),
      },
    });
    expect(after?.amountValue).toBe(1);
    expect(after?.deletedAt).toBeNull();
  });

  // The server owns the shelf default: a client that asks to adjust without
  // naming an entry (native hero action) must still decrement a sole shelf.
  it("takes the units off the sole shelf when adjusting without naming it", async () => {
    const { prod, entry } = await seedStockedProduct(3);

    const result = await discardProductUnits(
      ctx.db,
      {
        productId: prod.entityId,
        quantity: 2,
        date: "2026-06-03",
        trade: "other",
        reason: null,
        inventoryEntryId: null,
        adjustInventory: true,
      },
      ctx.actor,
    );

    expect(result.inventory).toMatchObject({ remainingValue: 1 });
    const after = await getDb(ctx.db).query.inventoryEntry.findFirst({
      where: {
        RAW: (table: PgTable) =>
          relationalSql(table, eq(inventoryEntry.id, entry.entityId)),
      },
    });
    expect(after?.amountValue).toBe(1);
  });

  it("refuses to guess among several shelves", async () => {
    const { prod } = await seedStockedProduct(3);
    const other = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Second bin" }),
      ctx.actor,
    );
    await createInventoryEntry(
      ctx.db,
      {
        productId: prod.entityId,
        locationId: other.entityId,
        amount: { value: 4, unit: "each" },
      },
      ctx.actor,
    );

    await expect(
      discardProductUnits(
        ctx.db,
        {
          productId: prod.entityId,
          quantity: 1,
          date: null,
          trade: "other",
          reason: null,
          inventoryEntryId: null,
          adjustInventory: true,
        },
        ctx.actor,
      ),
    ).rejects.toMatchObject({ reason: "CONSTRAINT_VIOLATION" });
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
      where: {
        RAW: (table: PgTable) =>
          relationalSql(table, eq(inventoryEntry.id, entry.entityId)),
      },
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
          eq(entityEmbedding.entityKind, "inventory"),
          eq(entityEmbedding.entityId, entry.entityId),
          isNull(entityEmbedding.deletedAt),
        ),
      );
    expect(live).toHaveLength(0);
  });

  // A member's own discard shows on the Product at once: no background pass.
  it.each([
    ["2026-06-03", "2026-06-03"],
    [null, null],
  ])(
    "reads the discarded Product's stock straight after a %s discard",
    async (date, exitedAt) => {
      const { prod } = await seedStockedProduct(1);
      await createRepoEntity(
        ctx,
        "expense",
        makeExpenseInput({
          productId: prod.id,
          date: "2026-01-02",
          cost: 165,
          productQuantity: 1,
          lineKind: "principal",
        }),
      );
      await discardProductUnits(
        ctx.db,
        {
          productId: prod.entityId,
          quantity: 1,
          date,
          trade: "other",
          reason: null,
          inventoryEntryId: null,
          adjustInventory: true,
        },
        ctx.actor,
      );

      const read = await getProductWithFood(ctx.db, food, prod.entityId);
      expect(read.quantityLedger).toMatchObject({
        acquiredUnits: 1,
        exitedUnits: 1,
        expectedQuantity: 0,
      });
      expect(read).toMatchObject({
        onHandUnits: null,
        primaryPlacement: null,
        stockStatus: "Recorded balance: 0",
        ownershipEvidence: {
          state: "exited",
          acquiredAt: "2026-01-02",
          exitedAt,
        },
      });
    },
  );

  it("keeps an exit with no recorded acquisition visible", async () => {
    const { prod } = await seedStockedProduct(1);
    await discardProductUnits(
      ctx.db,
      {
        productId: prod.entityId,
        quantity: 1,
        date: null,
        trade: "other",
        reason: null,
        inventoryEntryId: null,
        adjustInventory: true,
      },
      ctx.actor,
    );

    const read = await getProductWithFood(ctx.db, food, prod.entityId);
    expect(read.quantityLedger.expectedQuantity).toBe(-1);
    expect(read).toMatchObject({
      stockStatus: "Recorded exits exceed acquisitions",
      ownershipEvidence: { state: "uncertain", exitedAt: null },
    });
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

// Every stock write a member makes shows on the Product at once, with no
// background pass: Expense edit/delete, Inventory add/move/remove and recount.
describe("live Product stock after member writes", () => {
  const ctx = withTestDb();
  const food = { findFood: async () => null };

  it("reads each write back immediately", async () => {
    const shelf = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Synthetic live shelf" }),
      ctx.actor,
    );
    const bin = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Synthetic live bin" }),
      ctx.actor,
    );
    const prod = await createProduct(
      ctx.db,
      makeProductInput({ name: "Synthetic live drill" }),
      ctx.actor,
    );
    const { output: bought } = await createRepoEntity(
      ctx,
      "expense",
      makeExpenseInput({
        productId: prod.id,
        date: "2026-01-02",
        cost: 90,
        productQuantity: 1,
        lineKind: "principal",
      }),
    );
    const read = () => getProductWithFood(ctx.db, food, prod.entityId);
    const liveEntries = () =>
      getDb(ctx.db)
        .select({ id: inventoryEntry.id, updatedAt: inventoryEntry.updatedAt })
        .from(inventoryEntry)
        .where(
          and(
            eq(inventoryEntry.productId, prod.entityId),
            isNull(inventoryEntry.deletedAt),
          ),
        );

    // Inventory add.
    await createInventoryEntry(
      ctx.db,
      {
        productId: prod.entityId,
        locationId: shelf.entityId,
        amount: { value: 1, unit: "each" },
      },
      ctx.actor,
    );
    expect(await read()).toMatchObject({
      onHandUnits: 1,
      primaryPlacement: { locationId: shelf.id },
      stockStatus: "Located quantity matches records",
    });

    // Expense edit.
    await updateExpense(ctx.db, bought.id, { productQuantity: 2 }, ctx.actor);
    expect(await read()).toMatchObject({
      quantityLedger: { acquiredUnits: 2, expectedQuantity: 2 },
      stockStatus: "1 expected item unlocated",
    });

    // Inventory move.
    const [onShelf] = await liveEntries();
    await bulkMoveInventoryEntries(
      ctx.db,
      {
        sourceLocationId: shelf.entityId,
        targetLocationId: bin.entityId,
        items: [
          {
            inventoryEntryId: onShelf!.id,
            quantity: { value: 1, unit: "each" },
          },
        ],
      },
      ctx.actor,
    );
    expect((await read()).primaryPlacement).toMatchObject({
      locationId: bin.id,
    });

    // Recount.
    const [inBin] = await liveEntries();
    await reconcileLocationSession(
      ctx.db,
      {
        locationId: bin.entityId,
        expectedInventoryEntryIds: [inBin!.id],
        snapshotUpdatedAt: inBin!.updatedAt,
        resolutions: [
          {
            kind: "adjust",
            inventoryEntryId: inBin!.id,
            amount: { value: 2, unit: "each" },
          },
        ],
      },
      ctx.actor,
    );
    expect(await read()).toMatchObject({
      onHandUnits: 2,
      stockStatus: "Located quantity matches records",
    });

    // Inventory remove.
    await deleteInventoryEntries(ctx.db, [inBin!.id], ctx.actor);
    expect(await read()).toMatchObject({
      onHandUnits: null,
      primaryPlacement: null,
      stockStatus: "2 expected items unlocated",
    });

    // Expense delete.
    await deleteExpenses(ctx.db, [bought.id], ctx.actor);
    expect(await read()).toMatchObject({
      quantityLedger: { acquiredUnits: 0, expectedQuantity: 0 },
      stockStatus: "No inventory recorded",
    });
  });
});
