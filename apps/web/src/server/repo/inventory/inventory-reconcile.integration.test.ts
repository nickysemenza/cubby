import type { InventoryId, LocationId } from "@cubby/schemas/identifiers";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { inventoryEntry, location as locationTable } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import {
  createInventoryEntry,
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

  // The converse must still throw: flipping a row into the counted population
  // mid-session genuinely changes the snapshot.

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
});
