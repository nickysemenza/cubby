import type { InventoryId, LocationId } from "@cubby/schemas/identifiers";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { inventoryEntry } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import {
  bulkProcessInventoryEntries,
  createInventoryEntry,
  getInventoryLocationSnapshotToken,
} from "~/server/repo/inventory";
import { createLedgerParty } from "~/server/repo/ledger-party";
import { createLocation } from "~/server/repo/location";
import { createProduct } from "~/server/repo/product";
import {
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";

// bulkProcess deletes-on-omit, so a stale snapshot could silently delete entries
// another surface added since load. The optional `loadedAt` guard rejects the
// commit when anything at the location changed after that time.
// NOTE: a unique (productId, locationId) constraint means every entry at a
// location needs a distinct product.
describe("bulkProcessInventoryEntries staleness guard", () => {
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

  const addEntry = async (
    locationId: LocationId,
    productName: string,
    ownerLedgerPartyId?: Parameters<
      typeof createInventoryEntry
    >[1]["ownerLedgerPartyId"],
  ) => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: `Bolt ${productName}` }),
      TEST_ACTOR,
    );
    const productEntityId = parseEntityId(
      "product",
      await requireResolvedId(product.id, "product"),
    );
    const input: Parameters<typeof createInventoryEntry>[1] = {
      productId: productEntityId,
      locationId,
      amount,
    };
    if (ownerLedgerPartyId) {
      input.ownershipMode = "person";
      input.ownerLedgerPartyId = ownerLedgerPartyId;
    }
    const entry = await createInventoryEntry(ctx.db, input, TEST_ACTOR);
    const entryEntityId = parseEntityId(
      "inventory",
      await requireResolvedId(entry.id, "inventory"),
    );
    const item = {
      id: entryEntityId,
      productId: productEntityId,
      locationId,
      amount,
    };
    return { id: entryEntityId, item };
  };

  const seedLocation = async (name: string) => {
    const loc = await createLocation(
      ctx.db,
      makeLocationInput({ name }),
      TEST_ACTOR,
    );
    const locationEntityId = parseEntityId(
      "location",
      await requireResolvedId(loc.id, "location"),
    );
    const first = await addEntry(locationEntityId, `${name}-A`);
    return { loc, locationEntityId, first };
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
    const { locationEntityId, first } = await seedLocation("Stale");
    // loadedAt = the first entry's DB updatedAt; any later write is strictly newer.
    // Throw (don't fall back to `new Date()`) so a missing seed fails loudly
    // instead of silently making the `>` comparison ambiguous.
    const loaded = await readEntry(first.id);
    if (!loaded) throw new Error("seed entry missing");
    const loadedAt = new Date(loaded.at.getTime() - 1);

    const sneakedIn = await addEntry(locationEntityId, "sneaked");

    // Submitting the stale snapshot (only the original entry) would delete-on-omit
    // the new one — the guard must reject instead.
    await expect(
      bulkProcessInventoryEntries(
        ctx.db,
        locationEntityId,
        [first.item],
        TEST_ACTOR,
        loadedAt,
      ),
    ).rejects.toThrow(/changed since/i);

    expect((await readEntry(sneakedIn.id))?.deletedAt).toBeNull();
  });

  it("commits when loadedAt is current (delete-on-omit still applies)", async () => {
    const { locationEntityId, first } = await seedLocation("Fresh");
    const other = await addEntry(locationEntityId, "other");
    // A loadedAt in the future is never stale → the commit proceeds.
    const future = new Date(Date.now() + 60_000);

    await bulkProcessInventoryEntries(
      ctx.db,
      locationEntityId,
      [first.item],
      TEST_ACTOR,
      future,
    );

    // `other` was omitted from the submit, so it is soft-deleted (commit ran).
    expect((await readEntry(other.id))?.deletedAt).not.toBeNull();
  });

  it("skips the guard entirely when loadedAt is omitted (back-compat)", async () => {
    const { locationEntityId, first } = await seedLocation("NoGuard");
    const other = await addEntry(locationEntityId, "other");

    await bulkProcessInventoryEntries(
      ctx.db,
      locationEntityId,
      [first.item],
      TEST_ACTOR,
    );
    expect((await readEntry(other.id))?.deletedAt).not.toBeNull();
  });

  it("requires a complete token before ownership-aware delete-on-omit", async () => {
    const { locationEntityId, first } = await seedLocation("Owned snapshot");
    const owner = await createLedgerParty(
      ctx.db,
      { name: "Inventory owner", kind: "member", notes: null },
      TEST_ACTOR,
    );
    const owned = await addEntry(locationEntityId, "owned", owner.entityId);

    await expect(
      bulkProcessInventoryEntries(
        ctx.db,
        locationEntityId,
        [first.item],
        TEST_ACTOR,
      ),
    ).rejects.toThrow(/complete snapshot token/i);
    expect((await readEntry(owned.id))?.deletedAt).toBeNull();

    const snapshotToken = await getInventoryLocationSnapshotToken(
      ctx.db,
      locationEntityId,
    );
    await bulkProcessInventoryEntries(
      ctx.db,
      locationEntityId,
      [first.item],
      TEST_ACTOR,
      undefined,
      snapshotToken,
    );
    expect((await readEntry(owned.id))?.deletedAt).not.toBeNull();
  });
});
