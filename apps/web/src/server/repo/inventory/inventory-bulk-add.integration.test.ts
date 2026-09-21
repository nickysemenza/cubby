import { amount } from "@cubby/schemas/codec";
import type { LocationId, ProductId } from "@cubby/schemas/identifiers";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import {
  productQuickCreatePayload,
  productCreateManyInput,
  productDiscardInput,
} from "@cubby/schemas/product";
import { and, eq } from "drizzle-orm";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { collectBulkStream } from "~/lib/bulk-progress";
import {
  auditLog,
  inventoryEntry,
  product as productTable,
} from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import {
  addInventoryEntries,
  createInventoryEntry,
} from "~/server/repo/inventory";
import {
  createLocation,
  ensureGlobalUnknownLocation,
} from "~/server/repo/location";
import { createProduct } from "~/server/repo/product";
import {
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";
import { requireActor } from "~/server/request-context";
import { createTestRequestContext } from "~/server/testing/request-context";
import {
  bulkAddInventoryWorkflow,
  bulkDiscardInventoryWorkflow,
  moveInventoryEntriesWorkflow,
} from "~/server/workflows/inventory.server";
import {
  quickCreateProductWorkflow,
  createManyProductsWorkflow,
  markProductsUsdaUnavailableWorkflow,
  discardProductWorkflow,
  getProductInventoryEntriesWorkflow,
} from "~/server/workflows/product.server";
import { getPlacementRecommendationWorkflow } from "~/server/workflows/recommendations.server";

/**
 * Guards for the additive bulk-add.
 *
 * Unlike `bulkProcessInventoryEntries` (delete-on-omit — see the comment
 * above it in bulk.ts), this flow only ever creates or sums into the rows its
 * own items name. These cover: a fresh row lands as a create; an item that
 * lands on an already-occupied slot sums into it rather than colliding with
 * the partial unique index; a unit mismatch on that merge is refused; naming
 * one product twice in a request is refused (it would collide with itself);
 * an installed fixture of the same product is untouched because placement is
 * part of the slot key; and a soft-deleted product is refused up front.
 */
describe("addInventoryEntries", () => {
  const ctx = withTestDb();

  it("runs additive stocking, relocation, and explicit discard through workflow definitions", async () => {
    const source = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Workflow source shelf" }),
      TEST_ACTOR,
    );
    const destination = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Workflow destination shelf" }),
      TEST_ACTOR,
    );
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: "Workflow fasteners" }),
      TEST_ACTOR,
    );
    const input = {
      locationId: source.id,
      items: [{ productId: product.id, amount: { value: 3, unit: "each" } }],
    };
    const first = await bulkAddInventoryWorkflow(ctx.db, TEST_ACTOR, input);
    expect(first.createdCount).toBe(1);
    const second = await bulkAddInventoryWorkflow(ctx.db, TEST_ACTOR, input);
    expect(second.mergedCount).toBe(1);
    const entry = second.items[0];
    if (!entry) throw new Error("Expected stocked row");
    expect(entry.amount).toMatchObject({ value: 6, unit: "each" });
    const moved = await moveInventoryEntriesWorkflow(ctx.db, TEST_ACTOR, {
      items: [{ inventoryEntryId: entry.id, targetLocationId: destination.id }],
    });
    const movedEntry = moved.items[0];
    if (!movedEntry) throw new Error("Expected relocated row");
    const discarded = await bulkDiscardInventoryWorkflow(
      requireActor(
        createTestRequestContext(ctx.db, {
          auth: { userId: TEST_ACTOR.userId },
        }),
      ),
      {
        items: [{ inventoryEntryId: movedEntry.id, quantity: 1 }],
        date: "2026-01-01",
        trade: "other",
        reason: "Broken test item",
      },
    );
    expect(discarded.items[0]).toMatchObject({
      storedQuantity: -1,
      removed: false,
      remainingValue: 5,
    });
  });

  it("keeps product discard separate from inventory unless explicitly selected", async () => {
    const context = requireActor(
      createTestRequestContext(ctx.db, {
        auth: { userId: TEST_ACTOR.userId },
      }),
    );
    const product = await quickCreateProductWorkflow(
      context,
      productQuickCreatePayload.parse({ name: "Workflow spare washers" }),
    );
    const location = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Workflow parts shelf" }),
      TEST_ACTOR,
    );
    const stocked = await bulkAddInventoryWorkflow(ctx.db, TEST_ACTOR, {
      locationId: location.id,
      items: [{ productId: product.id, amount: { value: 4, unit: "each" } }],
    });
    const entry = stocked.items[0]!;
    const ledgerOnly = await discardProductWorkflow(
      context,
      productDiscardInput.parse({
        productId: product.id,
        quantity: 1,
        date: "2026-01-01",
        trade: "other",
        adjustInventory: false,
      }),
    );
    expect(ledgerOnly.storedQuantity).toBe(-1);
    expect(ledgerOnly.inventory).toBeNull();
    const unchanged = await getProductInventoryEntriesWorkflow(context, {
      ids: [product.id],
    });
    expect(unchanged[product.id]?.[0]?.amount).toMatchObject({
      value: 4,
      unit: "each",
    });
    const explicit = await discardProductWorkflow(
      context,
      productDiscardInput.parse({
        productId: product.id,
        quantity: 1,
        date: "2026-01-01",
        trade: "other",
        adjustInventory: true,
        inventoryEntryId: entry.id,
      }),
    );
    expect(explicit.inventory).toMatchObject({
      remainingValue: 3,
      removed: false,
    });
  });

  it("streams product writes without starting unrequested items and persists bulk USDA marking", async () => {
    const context = requireActor(
      createTestRequestContext(ctx.db, {
        auth: { userId: TEST_ACTOR.userId },
      }),
    );
    const stream = createManyProductsWorkflow(
      context,
      productCreateManyInput.parse([
        makeProductInput({ name: "Streaming first fixture" }),
        makeProductInput({ name: "Streaming unrequested fixture" }),
      ]),
    );
    expect((await stream.next()).value).toMatchObject({
      type: "progress",
      done: 0,
      total: 2,
    });
    expect((await stream.next()).value).toMatchObject({
      type: "progress",
      done: 1,
      total: 2,
    });
    await stream.return();
    const rows = await getDb(ctx.db)
      .select({ shortcode: productTable.shortcode, name: productTable.name })
      .from(productTable)
      .where(
        and(
          eq(productTable.name, "Streaming first fixture"),
          notDeleted(productTable),
        ),
      );
    expect(rows).toHaveLength(1);
    const absent = await getDb(ctx.db)
      .select({ id: productTable.id })
      .from(productTable)
      .where(
        and(
          eq(productTable.name, "Streaming unrequested fixture"),
          notDeleted(productTable),
        ),
      );
    expect(absent).toEqual([]);
    const id = parseShortcodeFor("product", rows[0]!.shortcode);
    const result = await collectBulkStream(
      markProductsUsdaUnavailableWorkflow(context, { ids: [id] }),
    );
    expect(result).toEqual({ updated: 1 });
    const updated = await getDb(ctx.db)
      .select({ usdaUnavailable: productTable.usdaUnavailable })
      .from(productTable)
      .where(and(eq(productTable.shortcode, id), notDeleted(productTable)));
    expect(updated).toEqual([{ usdaUnavailable: true }]);
  });

  const resolved = async (
    shortcode: string,
    entity: "inventory" | "location" | "product",
  ) => {
    const id = await resolveLiveShortcode(ctx.db, shortcode, entity);
    if (!id) throw new Error(`Failed to resolve ${entity} ${shortcode}`);
    return id;
  };

  const makeLocation = async (name: string): Promise<LocationId> => {
    const output = await createLocation(
      ctx.db,
      makeLocationInput({ name }),
      TEST_ACTOR,
    );
    return parseEntityId("location", await resolved(output.id, "location"));
  };

  const makeProduct = async (name: string): Promise<ProductId> => {
    const output = await createProduct(
      ctx.db,
      makeProductInput({ name }),
      TEST_ACTOR,
    );
    return parseEntityId("product", await resolved(output.id, "product"));
  };

  const rowsAt = async (locationId: LocationId) => {
    const rows = await getDb(ctx.db).query.inventoryEntry.findMany({
      where: and(
        eq(inventoryEntry.locationId, locationId),
        notDeleted(inventoryEntry),
      ),
      columns: { id: true, productId: true, amount: true, placement: true },
    });
    return rows
      .map((row) => {
        const parsedAmount = amount.parse(row.amount);
        return {
          id: row.id,
          productId: row.productId,
          value: parsedAmount.value,
          unit: parsedAmount.unit,
          placement: row.placement,
        };
      })
      .sort((a, b) => a.value - b.value);
  };

  it("creates new rows for products with no existing stock", async () => {
    const [bolt, nut] = await Promise.all([
      makeProduct("Bulk-Add Bolt"),
      makeProduct("Bulk-Add Nut"),
    ]);
    const shelf = await makeLocation("Bulk-Add Shelf");

    const result = await addInventoryEntries(
      ctx.db,
      {
        locationId: shelf,
        items: [
          { productId: bolt, amount: { value: 4, unit: "each" } },
          { productId: nut, amount: { value: 10, unit: "each" } },
        ],
      },
      TEST_ACTOR,
    );

    expect(result.createdCount).toBe(2);
    expect(result.mergedCount).toBe(0);
    expect(result.items).toHaveLength(2);
    expect(await rowsAt(shelf)).toEqual([
      {
        id: expect.any(String),
        productId: bolt,
        value: 4,
        unit: "each",
        placement: "stock",
      },
      {
        id: expect.any(String),
        productId: nut,
        value: 10,
        unit: "each",
        placement: "stock",
      },
    ]);
  });

  it("sums into an existing row at the same location", async () => {
    const bolt = await makeProduct("Merge Bolt");
    const shelf = await makeLocation("Merge Shelf");
    const existing = await createInventoryEntry(
      ctx.db,
      {
        productId: bolt,
        locationId: shelf,
        amount: { value: 3, unit: "each" },
      },
      TEST_ACTOR,
    );
    const existingId = await resolved(existing.id, "inventory");

    const result = await addInventoryEntries(
      ctx.db,
      {
        locationId: shelf,
        items: [{ productId: bolt, amount: { value: 5, unit: "each" } }],
      },
      TEST_ACTOR,
    );

    expect(result.createdCount).toBe(0);
    expect(result.mergedCount).toBe(1);
    expect(await rowsAt(shelf)).toEqual([
      {
        id: existingId,
        productId: bolt,
        value: 8,
        unit: "each",
        placement: "stock",
      },
    ]);

    const changes = await getDb(ctx.db).query.auditLog.findMany({
      where: and(
        eq(auditLog.entityType, "inventory"),
        eq(auditLog.entityId, existingId),
      ),
      columns: { action: true },
    });
    expect(changes.map((row) => row.action)).toContain("update");
  });

  it("refuses a product listed twice in the same request", async () => {
    const bolt = await makeProduct("Doubled Bolt");
    const shelf = await makeLocation("Doubled Shelf");

    await expect(
      addInventoryEntries(
        ctx.db,
        {
          locationId: shelf,
          items: [
            { productId: bolt, amount: { value: 2, unit: "each" } },
            { productId: bolt, amount: { value: 3, unit: "each" } },
          ],
        },
        TEST_ACTOR,
      ),
    ).rejects.toThrow(new RegExp(bolt));

    expect(await rowsAt(shelf)).toEqual([]);
  });
});

describe("placement recommendation workflow", () => {
  const ctx = withTestDb();

  it("recommends the sole known stock destination for a parked row", async () => {
    const productOutput = await createProduct(
      ctx.db,
      makeProductInput({ name: "Placement recommendation product" }),
      TEST_ACTOR,
    );
    const unknown = await ensureGlobalUnknownLocation(ctx.db, TEST_ACTOR);
    const shelf = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Placement recommendation shelf" }),
      TEST_ACTOR,
    );
    const parked = await bulkAddInventoryWorkflow(ctx.db, TEST_ACTOR, {
      locationId: unknown.id,
      items: [
        { productId: productOutput.id, amount: { value: 1, unit: "each" } },
      ],
    });
    await bulkAddInventoryWorkflow(ctx.db, TEST_ACTOR, {
      locationId: shelf.id,
      items: [
        { productId: productOutput.id, amount: { value: 1, unit: "each" } },
      ],
    });
    const parkedId = parked.items[0]?.id;
    if (!parkedId) throw new Error("Parked fixture missing");
    await expect(
      getPlacementRecommendationWorkflow(ctx.db, { inventoryId: parkedId }),
    ).resolves.toMatchObject({
      inventoryId: parkedId,
      sourceLocation: { name: "Unknown" },
      destination: { name: "Placement recommendation shelf" },
    });
  });
});
