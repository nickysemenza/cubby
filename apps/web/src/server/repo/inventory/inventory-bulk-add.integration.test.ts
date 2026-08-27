import type { LocationId, ProductId } from "@cubby/schemas/identifiers";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { and, eq } from "drizzle-orm";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { auditLog, inventoryEntry, product } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import {
  addInventoryEntries,
  createInventoryEntry,
} from "~/server/repo/inventory";
import { createLocation } from "~/server/repo/location";
import { createProduct } from "~/server/repo/product";
import {
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";

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
      .map((row) => ({
        id: row.id,
        productId: row.productId,
        value: (row.amount as { value: number; unit: string }).value,
        unit: (row.amount as { value: number; unit: string }).unit,
        placement: row.placement,
      }))
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

  it("refuses to sum mismatched units into an existing row", async () => {
    const bolt = await makeProduct("Unit Mismatch Bolt");
    const shelf = await makeLocation("Unit Mismatch Shelf");
    await createInventoryEntry(
      ctx.db,
      { productId: bolt, locationId: shelf, amount: { value: 3, unit: "lb" } },
      TEST_ACTOR,
    );

    await expect(
      addInventoryEntries(
        ctx.db,
        {
          locationId: shelf,
          items: [{ productId: bolt, amount: { value: 5, unit: "each" } }],
        },
        TEST_ACTOR,
      ),
    ).rejects.toThrow(/different unit/);

    // Refused before any write — the existing row is untouched.
    expect(await rowsAt(shelf)).toEqual([
      {
        id: expect.any(String),
        productId: bolt,
        value: 3,
        unit: "lb",
        placement: "stock",
      },
    ]);
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

  it("leaves an installed fixture of the same product untouched", async () => {
    // Placement is part of the slot key: an item targeting stock must never
    // merge into — or disturb — an installed fixture of the same product.
    const dimmer = await makeProduct("Fixture Dimmer");
    const room = await makeLocation("Fixture Room");
    const fixture = await createInventoryEntry(
      ctx.db,
      {
        productId: dimmer,
        locationId: room,
        amount: { value: 1, unit: "each" },
        placement: "installed",
      },
      TEST_ACTOR,
    );
    const fixtureId = await resolved(fixture.id, "inventory");

    const result = await addInventoryEntries(
      ctx.db,
      {
        locationId: room,
        items: [{ productId: dimmer, amount: { value: 2, unit: "each" } }],
      },
      TEST_ACTOR,
    );

    expect(result.createdCount).toBe(1);
    expect(result.mergedCount).toBe(0);
    expect(await rowsAt(room)).toEqual(
      expect.arrayContaining([
        {
          id: fixtureId,
          productId: dimmer,
          value: 1,
          unit: "each",
          placement: "installed",
        },
        {
          id: expect.any(String),
          productId: dimmer,
          value: 2,
          unit: "each",
          placement: "stock",
        },
      ]),
    );
  });

  it("rejects a soft-deleted product", async () => {
    const gone = await makeProduct("Deleted Product");
    const shelf = await makeLocation("Deleted Product Shelf");
    await getDb(ctx.db)
      .update(product)
      .set({ deletedAt: new Date() })
      .where(eq(product.id, gone));

    await expect(
      addInventoryEntries(
        ctx.db,
        {
          locationId: shelf,
          items: [{ productId: gone, amount: { value: 1, unit: "each" } }],
        },
        TEST_ACTOR,
      ),
    ).rejects.toThrow(/does not exist or has been deleted/);

    expect(await rowsAt(shelf)).toEqual([]);
  });
});
