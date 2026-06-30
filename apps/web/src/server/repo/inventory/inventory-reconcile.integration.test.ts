import type { InventoryId, LocationId } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { inventoryEntry, location as locationTable } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import {
  bulkMoveInventoryEntries,
  completeLocationAudit,
  createInventoryEntry,
} from "~/server/repo/inventory";
import { createLocation } from "~/server/repo/location";
import { createProduct } from "~/server/repo/product";
import {
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";

// Guards for the audit-session commit: completeLocationAudit must durably record
// `verifiedAt` + stamp the location, without deleting anything; and a plain move
// must NOT stamp `lastBulkInventory` (only an explicit completion does).
describe("completeLocationAudit", () => {
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

  it("stamps verifiedAt + lastBulkInventory on a confirm, with no delete", async () => {
    const { loc, entry } = await seedEntry("Shelf");
    expect((await readEntry(entry.id))?.verifiedAt).toBeNull();

    const result = await completeLocationAudit(
      ctx.db,
      loc.id,
      [entry.id],
      TEST_ACTOR,
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.verifiedAt).not.toBeNull();

    const after = await readEntry(entry.id);
    expect(after?.verifiedAt).not.toBeNull();
    expect(after?.deletedAt).toBeNull(); // verify never deletes
    expect((await readLocation(loc.id))?.lastBulkInventory).not.toBeNull();
  });

  it("an empty confirm set still stamps the location (nothing verified)", async () => {
    const { loc, entry } = await seedEntry("Empty walk");
    await completeLocationAudit(ctx.db, loc.id, [], TEST_ACTOR);
    expect((await readEntry(entry.id))?.verifiedAt).toBeNull();
    expect((await readLocation(loc.id))?.lastBulkInventory).not.toBeNull();
  });

  it("ignores ids that don't live at the audited location", async () => {
    const a = await seedEntry("Bin A");
    const b = await seedEntry("Bin B");
    // Audit Bin B but pass Bin A's entry id — it must not be verified.
    await completeLocationAudit(ctx.db, b.loc.id, [a.entry.id], TEST_ACTOR);
    expect((await readEntry(a.entry.id))?.verifiedAt).toBeNull();
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
