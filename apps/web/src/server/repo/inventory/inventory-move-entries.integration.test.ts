import { amount } from "@cubby/schemas/codec";
import type {
  InventoryId,
  LocationId,
  ProductId,
} from "@cubby/schemas/identifiers";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { and, eq } from "drizzle-orm";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { auditLog, inventoryEntry } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import {
  createInventoryEntry,
  moveInventoryEntries,
} from "~/server/repo/inventory";
import { createLocation } from "~/server/repo/location";
import { createProduct } from "~/server/repo/product";
import {
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";

/**
 * Guards for the many→many move.
 *
 * The single-source predecessor got the four per-item branches right, but it
 * could rely on `InventoryEntry_productId_locationId_key` guaranteeing that no
 * two items ever touched the same row: one source location holds one row per
 * product, and every item shared one destination. Per-item destinations remove
 * that guarantee in both directions, so these cover the cases that only exist
 * now — several sources converging on one row, one entry drawn down twice, and
 * a destination whose previous occupant leaves in the same request.
 */
describe("moveInventoryEntries", () => {
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

  const makeEntry = async (
    productId: ProductId,
    locationId: LocationId,
    value: number,
    unit = "each",
  ): Promise<InventoryId> => {
    const entry = await createInventoryEntry(
      ctx.db,
      { productId, locationId, amount: { value, unit } },
      TEST_ACTOR,
    );
    return parseEntityId("inventory", await resolved(entry.id, "inventory"));
  };

  const liveAt = async (locationId: LocationId) => {
    const rows = await getDb(ctx.db).query.inventoryEntry.findMany({
      where: and(
        eq(inventoryEntry.locationId, locationId),
        notDeleted(inventoryEntry),
      ),
      columns: { id: true, productId: true, amount: true },
    });
    return rows
      .map((row) => ({
        productId: row.productId,
        value: amount.parse(row.amount).value,
      }))
      .sort((a, b) => a.value - b.value);
  };

  const auditFor = (entityId: InventoryId) =>
    getDb(ctx.db).query.auditLog.findMany({
      where: and(
        eq(auditLog.entityType, "inventory"),
        eq(auditLog.entityId, entityId),
      ),
      columns: { action: true },
    });

  it("converges several sources onto one destination row", async () => {
    const bolt = await makeProduct("Converge Bolt");
    const [shelfA, shelfB, drawer] = await Promise.all([
      makeLocation("Converge A"),
      makeLocation("Converge B"),
      makeLocation("Converge Drawer"),
    ]);
    const fromA = await makeEntry(bolt, shelfA, 4);
    const fromB = await makeEntry(bolt, shelfB, 6);
    await makeEntry(bolt, drawer, 1);

    await moveInventoryEntries(
      ctx.db,
      {
        items: [
          { inventoryEntryId: fromA, targetLocationId: drawer },
          { inventoryEntryId: fromB, targetLocationId: drawer },
        ],
      },
      TEST_ACTOR,
    );

    expect(await liveAt(drawer)).toEqual([{ productId: bolt, value: 11 }]);
    expect(await liveAt(shelfA)).toEqual([]);
    expect(await liveAt(shelfB)).toEqual([]);
    // A fully-moved source that collapsed into an existing row is HARD-deleted,
    // not soft-deleted: a zero-quantity ghost is hidden by notDeleted() but
    // resurfaces in valuation and duplicate scans.
    const goneA = await getDb(ctx.db).query.inventoryEntry.findFirst({
      where: eq(inventoryEntry.id, fromA),
    });
    expect(goneA).toBeUndefined();
    expect((await auditFor(fromA)).map((row) => row.action)).toContain(
      "delete",
    );
  });

  it("splits one entry across two destinations", async () => {
    const bolt = await makeProduct("Split Bolt");
    const [shelf, left, right] = await Promise.all([
      makeLocation("Split Shelf"),
      makeLocation("Split Left"),
      makeLocation("Split Right"),
    ]);
    const entry = await makeEntry(bolt, shelf, 10);

    await moveInventoryEntries(
      ctx.db,
      {
        items: [
          {
            inventoryEntryId: entry,
            targetLocationId: left,
            quantity: { value: 3, unit: "each" },
          },
          // No quantity — takes whatever the first item left behind, which is
          // only correct if the source is drawn down in the plan rather than
          // read fresh from the pre-fetch.
          { inventoryEntryId: entry, targetLocationId: right },
        ],
      },
      TEST_ACTOR,
    );

    expect(await liveAt(left)).toEqual([{ productId: bolt, value: 3 }]);
    expect(await liveAt(right)).toEqual([{ productId: bolt, value: 7 }]);
    expect(await liveAt(shelf)).toEqual([]);
  });

  it("refuses to move more than the entry holds", async () => {
    const bolt = await makeProduct("Overdraw Bolt");
    const [from, to] = await Promise.all([
      makeLocation("Overdraw From"),
      makeLocation("Overdraw To"),
    ]);
    const entry = await makeEntry(bolt, from, 2);

    await expect(
      moveInventoryEntries(
        ctx.db,
        {
          items: [
            {
              inventoryEntryId: entry,
              targetLocationId: to,
              quantity: { value: 5, unit: "each" },
            },
          ],
        },
        TEST_ACTOR,
      ),
    ).rejects.toThrow(/only 2 available/);

    expect(await liveAt(from)).toEqual([{ productId: bolt, value: 2 }]);
  });
});
