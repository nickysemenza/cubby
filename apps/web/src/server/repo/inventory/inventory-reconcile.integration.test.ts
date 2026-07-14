import type { InventoryId, LocationId } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { inventoryEntry, location as locationTable } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import {
  bulkMoveInventoryEntries,
  createInventoryEntry,
  reconcileLocationSession,
} from "~/server/repo/inventory";
import { createLocation } from "~/server/repo/location";
import { createProduct } from "~/server/repo/product";
import {
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";

// Guards for the audit-session commit: reconcileLocationSession applies the
// complete staged diff atomically, rejects stale/partial snapshots, and stamps
// the location. A plain move must NOT stamp `lastBulkInventory` (only an
// explicit completion does).
describe("reconcileLocationSession", () => {
  const ctx = withTestDb();
  const amount = { value: 1, unit: "each" };

  const seedEntry = async (locationName: string) => {
    const loc = await createLocation(
      ctx.db,
      makeLocationInput({ name: locationName }),
      TEST_ACTOR,
    );
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: `Bolt ${locationName}` }),
      TEST_ACTOR,
    );
    const entry = await createInventoryEntry(
      ctx.db,
      { productId: product.id, locationId: loc.id, amount },
      TEST_ACTOR,
    );
    return { loc, entry };
  };

  const readEntry = (id: InventoryId) =>
    getDb(ctx.db).query.inventoryEntry.findFirst({
      where: eq(inventoryEntry.id, id),
    });
  const readLocation = (id: LocationId) =>
    getDb(ctx.db).query.location.findFirst({
      where: eq(locationTable.id, id),
    });

  it("verify stamps verifiedAt + lastBulkInventory, no delete, no recompute", async () => {
    const { loc, entry } = await seedEntry("Shelf");
    expect((await readEntry(entry.id))?.verifiedAt).toBeNull();

    const { items, recomputeNeeded } = await reconcileLocationSession(
      ctx.db,
      {
        locationId: loc.id,
        expectedInventoryEntryIds: [entry.id],
        snapshotUpdatedAt: entry.updatedAt,
        resolutions: [{ kind: "verify", inventoryEntryId: entry.id }],
      },
      TEST_ACTOR,
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.verifiedAt).not.toBeNull();
    expect(recomputeNeeded).toBe(false); // pure verify never recomputes

    const after = await readEntry(entry.id);
    expect(after?.verifiedAt).not.toBeNull();
    expect(after?.deletedAt).toBeNull();
    expect((await readLocation(loc.id))?.lastBulkInventory).not.toBeNull();
  });

  it("adjust updates amount + verifiedAt and flags recompute", async () => {
    const { loc, entry } = await seedEntry("Adjust");
    const { recomputeNeeded } = await reconcileLocationSession(
      ctx.db,
      {
        locationId: loc.id,
        expectedInventoryEntryIds: [entry.id],
        snapshotUpdatedAt: entry.updatedAt,
        resolutions: [
          {
            kind: "adjust",
            inventoryEntryId: entry.id,
            amount: { value: 5, unit: "each" },
          },
        ],
      },
      TEST_ACTOR,
    );
    expect(recomputeNeeded).toBe(true);

    const after = await readEntry(entry.id);
    expect(after?.amount).toEqual({ value: 5, unit: "each" });
    expect(after?.verifiedAt).not.toBeNull();
  });

  it("remove soft-deletes (row retained with deletedAt) and flags recompute", async () => {
    const { loc, entry } = await seedEntry("Remove");
    const { recomputeNeeded, removedIds } = await reconcileLocationSession(
      ctx.db,
      {
        locationId: loc.id,
        expectedInventoryEntryIds: [entry.id],
        snapshotUpdatedAt: entry.updatedAt,
        resolutions: [{ kind: "remove", inventoryEntryId: entry.id }],
      },
      TEST_ACTOR,
    );
    expect(recomputeNeeded).toBe(true);
    expect(removedIds).toEqual([entry.id]); // reported for delete side-effects

    const after = await readEntry(entry.id);
    expect(after).toBeDefined(); // soft delete: row kept
    expect(after?.deletedAt).not.toBeNull();
  });

  it("an actually empty location can still be completed", async () => {
    const loc = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Empty walk" }),
      TEST_ACTOR,
    );
    await reconcileLocationSession(
      ctx.db,
      {
        locationId: loc.id,
        expectedInventoryEntryIds: [],
        snapshotUpdatedAt: null,
        resolutions: [],
      },
      TEST_ACTOR,
    );
    expect((await readLocation(loc.id))?.lastBulkInventory).not.toBeNull();
  });

  it("rejects a partial or foreign resolution set", async () => {
    const a = await seedEntry("Bin A");
    const b = await seedEntry("Bin B");
    await expect(
      reconcileLocationSession(
        ctx.db,
        {
          locationId: b.loc.id,
          expectedInventoryEntryIds: [b.entry.id],
          snapshotUpdatedAt: b.entry.updatedAt,
          resolutions: [{ kind: "remove", inventoryEntryId: a.entry.id }],
        },
        TEST_ACTOR,
      ),
    ).rejects.toThrow("changed during the recount");
    const stranger = await readEntry(a.entry.id);
    expect(stranger?.deletedAt).toBeNull();
    expect(stranger?.verifiedAt).toBeNull();
    expect((await readLocation(b.loc.id))?.lastBulkInventory).toBeNull();
  });

  it("relocates atomically and stamps only the audited source", async () => {
    const { loc: source, entry } = await seedEntry("Relocate source");
    const target = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Relocate target" }),
      TEST_ACTOR,
    );

    const { items, recomputeNeeded } = await reconcileLocationSession(
      ctx.db,
      {
        locationId: source.id,
        expectedInventoryEntryIds: [entry.id],
        snapshotUpdatedAt: entry.updatedAt,
        resolutions: [
          {
            kind: "relocate",
            inventoryEntryId: entry.id,
            targetLocationId: target.id,
          },
        ],
      },
      TEST_ACTOR,
    );

    expect(recomputeNeeded).toBe(true);
    expect(items[0]?.location.id).toBe(target.id);
    expect((await readLocation(source.id))?.lastBulkInventory).not.toBeNull();
    expect((await readLocation(target.id))?.lastBulkInventory).toBeNull();
  });

  it("rejects when a row changed after the client snapshot", async () => {
    const { loc, entry } = await seedEntry("Stale recount");
    const snapshotUpdatedAt = new Date(0);
    await expect(
      reconcileLocationSession(
        ctx.db,
        {
          locationId: loc.id,
          expectedInventoryEntryIds: [entry.id],
          snapshotUpdatedAt,
          resolutions: [{ kind: "verify", inventoryEntryId: entry.id }],
        },
        TEST_ACTOR,
      ),
    ).rejects.toThrow("changed during the recount");
    expect((await readLocation(loc.id))?.lastBulkInventory).toBeNull();
  });

  it("a move no longer stamps lastBulkInventory", async () => {
    const { loc: source, entry } = await seedEntry("Source");
    const target = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Target" }),
      TEST_ACTOR,
    );

    await bulkMoveInventoryEntries(
      ctx.db,
      {
        sourceLocationId: source.id,
        targetLocationId: target.id,
        items: [{ inventoryEntryId: entry.id, quantity: amount }],
      },
      TEST_ACTOR,
    );

    expect((await readLocation(source.id))?.lastBulkInventory).toBeNull();
    expect((await readLocation(target.id))?.lastBulkInventory).toBeNull();
  });
});
