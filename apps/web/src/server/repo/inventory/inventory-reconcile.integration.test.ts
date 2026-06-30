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
// staged verify/adjust/remove diff durably and stamps the location, without
// touching anything it wasn't told to; and a plain move must NOT stamp
// `lastBulkInventory` (only an explicit completion does).
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
      loc.id,
      [{ kind: "verify", inventoryEntryId: entry.id }],
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
      loc.id,
      [
        {
          kind: "adjust",
          inventoryEntryId: entry.id,
          amount: { value: 5, unit: "each" },
        },
      ],
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
      loc.id,
      [{ kind: "remove", inventoryEntryId: entry.id }],
      TEST_ACTOR,
    );
    expect(recomputeNeeded).toBe(true);
    expect(removedIds).toEqual([entry.id]); // reported for delete side-effects

    const after = await readEntry(entry.id);
    expect(after).toBeDefined(); // soft delete: row kept
    expect(after?.deletedAt).not.toBeNull();
  });

  it("an empty commit still stamps the location", async () => {
    const { loc, entry } = await seedEntry("Empty walk");
    await reconcileLocationSession(ctx.db, loc.id, [], TEST_ACTOR);
    expect((await readEntry(entry.id))?.verifiedAt).toBeNull();
    expect((await readLocation(loc.id))?.lastBulkInventory).not.toBeNull();
  });

  it("ignores resolutions for ids that don't live at the audited location", async () => {
    const a = await seedEntry("Bin A");
    const b = await seedEntry("Bin B");
    await reconcileLocationSession(
      ctx.db,
      b.loc.id,
      [{ kind: "remove", inventoryEntryId: a.entry.id }],
      TEST_ACTOR,
    );
    const stranger = await readEntry(a.entry.id);
    expect(stranger?.deletedAt).toBeNull(); // untouched
    expect(stranger?.verifiedAt).toBeNull();
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
