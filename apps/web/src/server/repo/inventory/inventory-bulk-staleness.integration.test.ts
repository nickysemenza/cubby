import type { InventoryId, LocationId } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { inventoryEntry } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import {
  bulkProcessInventoryEntries,
  createInventoryEntry,
} from "~/server/repo/inventory";
import { createLocation } from "~/server/repo/location";
import { createProduct } from "~/server/repo/product";
import {
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";

// bulkProcess deletes-on-omit, so a stale snapshot could silently delete entries
// another surface added since load. The optional `loadedAt` guard rejects the
// commit when anything at the location changed after that time.
// NOTE: a unique (productId, locationId) constraint means every entry at a
// location needs a distinct product.
describe("bulkProcessInventoryEntries staleness guard", () => {
  const ctx = withTestDb();
  const amount = { value: 1, unit: "each" };

  // Add an entry (with a new product) to a location, returning the bulk-op item
  // that re-submits it unchanged.
  const addEntry = async (locationId: LocationId, productName: string) => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: `Bolt ${productName}` }),
      TEST_ACTOR,
    );
    const entry = await createInventoryEntry(
      ctx.db,
      { productId: product.id, locationId, amount },
      TEST_ACTOR,
    );
    const item = {
      id: entry.id,
      productId: product.id,
      locationId,
      amount,
    };
    return { id: entry.id, item };
  };

  const seedLocation = async (name: string) => {
    const loc = await createLocation(
      ctx.db,
      makeLocationInput({ name }),
      TEST_ACTOR,
    );
    const first = await addEntry(loc.id, `${name}-A`);
    return { loc, first };
  };

  const readEntry = (id: InventoryId) =>
    getDb(ctx.db)
      .select({
        deletedAt: inventoryEntry.deletedAt,
        at: inventoryEntry.updatedAt,
      })
      .from(inventoryEntry)
      .where(eq(inventoryEntry.id, id))
      .then((rows) => rows[0]);

  it("rejects a commit when an entry was added after loadedAt", async () => {
    const { loc, first } = await seedLocation("Stale");
    // loadedAt = the first entry's DB updatedAt; any later write is strictly newer.
    // Throw (don't fall back to `new Date()`) so a missing seed fails loudly
    // instead of silently making the `>` comparison ambiguous.
    const loaded = await readEntry(first.id);
    if (!loaded) throw new Error("seed entry missing");
    // Subtract 1 ms so first.updatedAt > loadedAt is guaranteed even if
    // sneakedIn gets the same millisecond timestamp as first.
    const loadedAt = new Date(loaded.at.getTime() - 1);

    // Another surface adds an entry after the snapshot was loaded.
    const sneakedIn = await addEntry(loc.id, "sneaked");

    // Submitting the stale snapshot (only the original entry) would delete-on-omit
    // the new one — the guard must reject instead.
    await expect(
      bulkProcessInventoryEntries(
        ctx.db,
        loc.id,
        [first.item],
        TEST_ACTOR,
        loadedAt,
      ),
    ).rejects.toThrow(/changed since/i);

    // The sneaked-in entry survives (the throw happened before the delete pass).
    expect((await readEntry(sneakedIn.id))?.deletedAt).toBeNull();
  });

  it("commits when loadedAt is current (delete-on-omit still applies)", async () => {
    const { loc, first } = await seedLocation("Fresh");
    const other = await addEntry(loc.id, "other");
    // A loadedAt in the future is never stale → the commit proceeds.
    const future = new Date(Date.now() + 60_000);

    await bulkProcessInventoryEntries(
      ctx.db,
      loc.id,
      [first.item],
      TEST_ACTOR,
      future,
    );

    // `other` was omitted from the submit, so it is soft-deleted (commit ran).
    expect((await readEntry(other.id))?.deletedAt).not.toBeNull();
  });

  it("skips the guard entirely when loadedAt is omitted (back-compat)", async () => {
    const { loc, first } = await seedLocation("NoGuard");
    const other = await addEntry(loc.id, "other");

    // No loadedAt → no staleness check; the omitted entry is deleted as before.
    await bulkProcessInventoryEntries(ctx.db, loc.id, [first.item], TEST_ACTOR);
    expect((await readEntry(other.id))?.deletedAt).not.toBeNull();
  });
});
