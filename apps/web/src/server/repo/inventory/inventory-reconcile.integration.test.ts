import type { InventoryId, LocationId } from "@cubby/schemas/identifiers";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { inventoryEntry, location as locationTable } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import {
  bulkMoveInventoryEntries,
  createInventoryEntry,
  getInventoryByLocationIds,
  reconcileLocationSession,
} from "~/server/repo/inventory";
import { createLocation } from "~/server/repo/location";
import { createProduct } from "~/server/repo/product";
import {
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";

// Guards for the audit-session commit: reconcileLocationSession applies the
// complete staged diff atomically, rejects stale/partial snapshots, and stamps
// the location. A plain move must NOT stamp `lastBulkInventory` (only an
// explicit completion does).
describe("reconcileLocationSession", () => {
  const ctx = withTestDb();
  const amount = { value: 1, unit: "each" };

  const requireResolvedId = async (
    shortcode: string,
    entity: "inventory" | "location" | "product",
  ) => {
    const entityId = await resolveLiveShortcode(ctx.db, shortcode, entity);
    if (!entityId) throw new Error(`Failed to resolve ${entity} ${shortcode}`);
    return entityId;
  };

  const createTestLocation = async (name: string) => {
    const output = await createLocation(
      ctx.db,
      makeLocationInput({ name }),
      TEST_ACTOR,
    );
    return {
      output,
      entityId: parseEntityId(
        "location",
        await requireResolvedId(output.id, "location"),
      ),
    };
  };

  const seedEntry = async (locationName: string) => {
    const { output: loc, entityId: locEntityId } =
      await createTestLocation(locationName);
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: `Bolt ${locationName}` }),
      TEST_ACTOR,
    );
    const productEntityId = parseEntityId(
      "product",
      await requireResolvedId(product.id, "product"),
    );
    const entry = await createInventoryEntry(
      ctx.db,
      { productId: productEntityId, locationId: locEntityId, amount },
      TEST_ACTOR,
    );
    const entryEntityId = parseEntityId(
      "inventory",
      await requireResolvedId(entry.id, "inventory"),
    );
    return { loc, locEntityId, entry, entryEntityId };
  };

  const readEntry = (id: InventoryId) =>
    getDb(ctx.db).query.inventoryEntry.findFirst({
      where: eq(inventoryEntry.id, id),
    });
  const readLocation = (id: LocationId) =>
    getDb(ctx.db).query.location.findFirst({
      where: eq(locationTable.id, id),
    });

  // The whole point of this test is that B is updated AFTER A, so B holds the
  // max(updatedAt) at the location. If the stale guard's max() scan is left
  // watching fixtures while the row snapshot is stock-only, the two watermarks
  // disagree and every recount in a room containing a fixture throws
  // INVENTORY_STALE forever. Without the ordering, this passes with the bug in.
  it("an installed entry is neither counted nor trips the stale guard", async () => {
    const { locEntityId, entry, entryEntityId } = await seedEntry("Wall");

    const fixtureProduct = await createProduct(
      ctx.db,
      makeProductInput({ name: "Rotary dimmer" }),
      TEST_ACTOR,
    );
    const fixture = await createInventoryEntry(
      ctx.db,
      {
        productId: parseEntityId(
          "product",
          await requireResolvedId(fixtureProduct.id, "product"),
        ),
        locationId: locEntityId,
        amount,
        placement: "installed",
      },
      TEST_ACTOR,
    );
    const fixtureEntityId = parseEntityId(
      "inventory",
      await requireResolvedId(fixture.id, "inventory"),
    );

    // Bump the fixture so it, not the stock row, holds the location watermark.
    await getDb(ctx.db)
      .update(inventoryEntry)
      .set({ amount: { value: 5, unit: "each" } })
      .where(eq(inventoryEntry.id, fixtureEntityId));

    const counted = await getInventoryByLocationIds(ctx.db, [locEntityId], {
      placement: "stock",
    });
    expect(counted.map((row) => row.id)).toEqual([entry.id]);

    const { items } = await reconcileLocationSession(
      ctx.db,
      {
        locationId: locEntityId,
        expectedInventoryEntryIds: [entryEntityId],
        snapshotUpdatedAt: entry.updatedAt,
        resolutions: [{ kind: "verify", inventoryEntryId: entryEntityId }],
      },
      TEST_ACTOR,
    );
    expect(items).toHaveLength(1);

    const fixtureAfter = await readEntry(fixtureEntityId);
    expect(fixtureAfter?.verifiedAt).toBeNull();
    expect(fixtureAfter?.deletedAt).toBeNull();
  });

  // The converse must still throw: flipping a row into the counted population
  // mid-session genuinely changes the snapshot.
  it("flipping a fixture back to stock mid-session throws INVENTORY_STALE", async () => {
    const { locEntityId, entry, entryEntityId } = await seedEntry("Ceiling");

    const canProduct = await createProduct(
      ctx.db,
      makeProductInput({ name: "Recessed can" }),
      TEST_ACTOR,
    );
    const can = await createInventoryEntry(
      ctx.db,
      {
        productId: parseEntityId(
          "product",
          await requireResolvedId(canProduct.id, "product"),
        ),
        locationId: locEntityId,
        amount,
        placement: "installed",
      },
      TEST_ACTOR,
    );
    const canEntityId = parseEntityId(
      "inventory",
      await requireResolvedId(can.id, "inventory"),
    );

    await getDb(ctx.db)
      .update(inventoryEntry)
      .set({ placement: "stock" })
      .where(eq(inventoryEntry.id, canEntityId));

    await expect(
      reconcileLocationSession(
        ctx.db,
        {
          locationId: locEntityId,
          expectedInventoryEntryIds: [entryEntityId],
          snapshotUpdatedAt: entry.updatedAt,
          resolutions: [{ kind: "verify", inventoryEntryId: entryEntityId }],
        },
        TEST_ACTOR,
      ),
    ).rejects.toThrow(/changed during the recount/);
  });

  it("verify stamps verifiedAt + lastBulkInventory, no delete, no recompute", async () => {
    const { locEntityId, entry, entryEntityId } = await seedEntry("Shelf");
    expect((await readEntry(entryEntityId))?.verifiedAt).toBeNull();

    const { items, recomputeNeeded } = await reconcileLocationSession(
      ctx.db,
      {
        locationId: locEntityId,
        expectedInventoryEntryIds: [entryEntityId],
        snapshotUpdatedAt: entry.updatedAt,
        resolutions: [{ kind: "verify", inventoryEntryId: entryEntityId }],
      },
      TEST_ACTOR,
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.verifiedAt).not.toBeNull();
    expect(recomputeNeeded).toBe(false); // pure verify never recomputes

    const after = await readEntry(entryEntityId);
    expect(after?.verifiedAt).not.toBeNull();
    expect(after?.deletedAt).toBeNull();
    expect((await readLocation(locEntityId))?.lastBulkInventory).not.toBeNull();
  });

  it("adjust updates amount + verifiedAt and flags recompute", async () => {
    const { locEntityId, entry, entryEntityId } = await seedEntry("Adjust");
    const { recomputeNeeded } = await reconcileLocationSession(
      ctx.db,
      {
        locationId: locEntityId,
        expectedInventoryEntryIds: [entryEntityId],
        snapshotUpdatedAt: entry.updatedAt,
        resolutions: [
          {
            kind: "adjust",
            inventoryEntryId: entryEntityId,
            amount: { value: 5, unit: "each" },
          },
        ],
      },
      TEST_ACTOR,
    );
    expect(recomputeNeeded).toBe(true);

    const after = await readEntry(entryEntityId);
    expect(after?.amount).toEqual({ value: 5, unit: "each" });
    expect(after?.verifiedAt).not.toBeNull();
  });

  it("remove soft-deletes (row retained with deletedAt) and flags recompute", async () => {
    const { locEntityId, entry, entryEntityId } = await seedEntry("Remove");
    const { recomputeNeeded, removedIds } = await reconcileLocationSession(
      ctx.db,
      {
        locationId: locEntityId,
        expectedInventoryEntryIds: [entryEntityId],
        snapshotUpdatedAt: entry.updatedAt,
        resolutions: [{ kind: "remove", inventoryEntryId: entryEntityId }],
      },
      TEST_ACTOR,
    );
    expect(recomputeNeeded).toBe(true);
    expect(removedIds).toEqual([entryEntityId]); // reported for delete side-effects

    const after = await readEntry(entryEntityId);
    expect(after).toBeDefined(); // soft delete: row kept
    expect(after?.deletedAt).not.toBeNull();
  });

  it("an actually empty location can still be completed", async () => {
    const { entityId: locationEntityId } =
      await createTestLocation("Empty walk");
    await reconcileLocationSession(
      ctx.db,
      {
        locationId: locationEntityId,
        expectedInventoryEntryIds: [],
        snapshotUpdatedAt: null,
        resolutions: [],
      },
      TEST_ACTOR,
    );
    expect(
      (await readLocation(locationEntityId))?.lastBulkInventory,
    ).not.toBeNull();
  });

  it("rejects a partial or foreign resolution set", async () => {
    const a = await seedEntry("Bin A");
    const b = await seedEntry("Bin B");
    await expect(
      reconcileLocationSession(
        ctx.db,
        {
          locationId: b.locEntityId,
          expectedInventoryEntryIds: [b.entryEntityId],
          snapshotUpdatedAt: b.entry.updatedAt,
          resolutions: [{ kind: "remove", inventoryEntryId: a.entryEntityId }],
        },
        TEST_ACTOR,
      ),
    ).rejects.toThrow("changed during the recount");
    const stranger = await readEntry(a.entryEntityId);
    expect(stranger?.deletedAt).toBeNull();
    expect(stranger?.verifiedAt).toBeNull();
    expect((await readLocation(b.locEntityId))?.lastBulkInventory).toBeNull();
  });

  it("relocates atomically and stamps only the audited source", async () => {
    const {
      locEntityId: sourceEntityId,
      entry,
      entryEntityId,
    } = await seedEntry("Relocate source");
    const { output: target, entityId: targetEntityId } =
      await createTestLocation("Relocate target");

    const { items, recomputeNeeded } = await reconcileLocationSession(
      ctx.db,
      {
        locationId: sourceEntityId,
        expectedInventoryEntryIds: [entryEntityId],
        snapshotUpdatedAt: entry.updatedAt,
        resolutions: [
          {
            kind: "relocate",
            inventoryEntryId: entryEntityId,
            targetLocationId: targetEntityId,
          },
        ],
      },
      TEST_ACTOR,
    );

    expect(recomputeNeeded).toBe(true);
    expect(items[0]?.location.id).toBe(target.id);
    expect(
      (await readLocation(sourceEntityId))?.lastBulkInventory,
    ).not.toBeNull();
    expect((await readLocation(targetEntityId))?.lastBulkInventory).toBeNull();
  });

  it("rejects when a row changed after the client snapshot", async () => {
    const { locEntityId, entryEntityId } = await seedEntry("Stale recount");
    const snapshotUpdatedAt = new Date(0);
    await expect(
      reconcileLocationSession(
        ctx.db,
        {
          locationId: locEntityId,
          expectedInventoryEntryIds: [entryEntityId],
          snapshotUpdatedAt,
          resolutions: [{ kind: "verify", inventoryEntryId: entryEntityId }],
        },
        TEST_ACTOR,
      ),
    ).rejects.toThrow("changed during the recount");
    expect((await readLocation(locEntityId))?.lastBulkInventory).toBeNull();
  });

  it("a move no longer stamps lastBulkInventory", async () => {
    const { locEntityId: sourceEntityId, entryEntityId } =
      await seedEntry("Source");
    const { entityId: targetEntityId } = await createTestLocation("Target");

    await bulkMoveInventoryEntries(
      ctx.db,
      {
        sourceLocationId: sourceEntityId,
        targetLocationId: targetEntityId,
        items: [{ inventoryEntryId: entryEntityId, quantity: amount }],
      },
      TEST_ACTOR,
    );

    expect((await readLocation(sourceEntityId))?.lastBulkInventory).toBeNull();
    expect((await readLocation(targetEntityId))?.lastBulkInventory).toBeNull();
  });
});
