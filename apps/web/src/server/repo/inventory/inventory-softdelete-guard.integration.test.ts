import {
  unsafeInventoryId,
  unsafeLocationId,
  unsafeProductId,
} from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import { TEST_ACTOR, TEST_HOME_ID, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { inventoryEntry } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import {
  bulkMoveInventoryEntries,
  bulkProcessInventoryEntries,
  createInventoryEntry,
  updateInventoryEntry,
} from "~/server/repo/inventory";
import { createLocation, deleteLocations } from "~/server/repo/location";
import { createProduct, deleteProducts } from "~/server/repo/product";
import {
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";

// Regression guard for the soft-delete leak fixed in Sweep 2:
// inventory writes must reject a product/location that's been soft-deleted, so a
// live entry can never reference a "gone" parent (which previously leaked into
// global search — see repo/search.ts). A product/location with no inventory can
// be soft-deleted, so this state is reachable without the guard.
describe("inventory soft-delete target guard", () => {
  const ctx = withTestDb();

  const amount = { value: 1, unit: "lbs" };

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
      entityId: unsafeLocationId(
        await requireResolvedId(output.id, "location"),
      ),
    };
  };

  const createTestProduct = async (name: string) => {
    const output = await createProduct(
      ctx.db,
      makeProductInput({ name }),
      TEST_ACTOR,
    );
    return {
      output,
      entityId: unsafeProductId(await requireResolvedId(output.id, "product")),
    };
  };

  const createTestEntry = async (
    productId: ReturnType<typeof unsafeProductId>,
    locationId: ReturnType<typeof unsafeLocationId>,
  ) => {
    const output = await createInventoryEntry(
      ctx.db,
      { productId, locationId, amount },
      TEST_ACTOR,
    );
    return {
      output,
      entityId: unsafeInventoryId(
        await requireResolvedId(output.id, "inventory"),
      ),
    };
  };

  const liveLocation = () => createTestLocation("Shelf");
  const liveProduct = () => createTestProduct("Flour");

  it("createInventoryEntry rejects a soft-deleted product", async () => {
    const { entityId: locationId } = await liveLocation();
    const { entityId: productId } = await liveProduct();
    // No inventory yet, so the product can be soft-deleted.
    await deleteProducts(ctx.db, [productId], TEST_ACTOR);

    await expect(
      createInventoryEntry(
        ctx.db,
        { productId, locationId, amount },
        TEST_ACTOR,
      ),
    ).rejects.toThrow(/does not exist or has been deleted/);
  });

  it("createInventoryEntry rejects a soft-deleted location", async () => {
    const { entityId: locationId } = await liveLocation();
    const { entityId: productId } = await liveProduct();
    await deleteLocations(ctx.db, [locationId], TEST_ACTOR);

    await expect(
      createInventoryEntry(
        ctx.db,
        { productId, locationId, amount },
        TEST_ACTOR,
      ),
    ).rejects.toThrow(/does not exist or has been deleted/);
  });

  it("updateInventoryEntry rejects re-pointing at a soft-deleted product", async () => {
    const { entityId: locationId } = await liveLocation();
    const { entityId: productId } = await liveProduct();
    const { entityId: entryId } = await createTestEntry(productId, locationId);

    // A second product with no inventory can be soft-deleted, then can't be
    // moved onto the live entry.
    const { entityId: deadProductId } = await createTestProduct("Sugar");
    await deleteProducts(ctx.db, [deadProductId], TEST_ACTOR);

    await expect(
      updateInventoryEntry(
        ctx.db,
        entryId,
        { productId: deadProductId },
        TEST_ACTOR,
      ),
    ).rejects.toThrow(/does not exist or has been deleted/);
  });

  it("updateInventoryEntry rejects re-pointing at a soft-deleted location", async () => {
    const { entityId: locationId } = await liveLocation();
    const { entityId: productId } = await liveProduct();
    const { entityId: entryId } = await createTestEntry(productId, locationId);

    // An empty second location can be soft-deleted, then can't be moved onto.
    const { entityId: deadLocationId } = await createTestLocation("Closet");
    await deleteLocations(ctx.db, [deadLocationId], TEST_ACTOR);

    await expect(
      updateInventoryEntry(
        ctx.db,
        entryId,
        { locationId: deadLocationId },
        TEST_ACTOR,
      ),
    ).rejects.toThrow(/does not exist or has been deleted/);
  });

  it("bulkProcessInventoryEntries rejects a soft-deleted location", async () => {
    const { entityId: productId } = await liveProduct();
    const { entityId: locationId } = await liveLocation();
    await deleteLocations(ctx.db, [locationId], TEST_ACTOR);

    await expect(
      bulkProcessInventoryEntries(
        ctx.db,
        locationId,
        [{ productId, locationId, amount }],
        TEST_ACTOR,
      ),
    ).rejects.toThrow(/does not exist or has been deleted/);
  });

  // Regression guard: bulkProcess is a delete-on-omit reconcile. An existing
  // entry not present in the submitted batch must be SOFT-deleted (row retained
  // with deletedAt), not hard-deleted — otherwise an omitted row is
  // unrecoverable, violating the repo-wide soft-delete invariant. Previously
  // this branch issued a raw tx.delete.
  it("bulkProcessInventoryEntries soft-deletes (not hard-deletes) omitted entries", async () => {
    const { entityId: locationId } = await liveLocation();
    const { entityId: productId } = await liveProduct();
    const { entityId: entryId } = await createTestEntry(productId, locationId);

    // Submit an empty batch: the existing entry is omitted, so it is removed.
    await bulkProcessInventoryEntries(ctx.db, locationId, [], TEST_ACTOR);

    // The row must still exist with deletedAt set (soft delete), not be gone.
    const raw = await getDb(ctx.db).query.inventoryEntry.findFirst({
      where: eq(inventoryEntry.id, entryId),
    });
    expect(raw).toBeDefined();
    expect(raw?.deletedAt).not.toBeNull();
  });

  it("bulkMoveInventoryEntries rejects a soft-deleted target location", async () => {
    const { entityId: sourceId } = await liveLocation();
    const { entityId: productId } = await liveProduct();
    const { entityId: entryId } = await createTestEntry(productId, sourceId);

    const { entityId: deadTargetId } = await createTestLocation("Closed Shelf");
    await deleteLocations(ctx.db, [deadTargetId], TEST_ACTOR);

    await expect(
      bulkMoveInventoryEntries(
        ctx.db,
        {
          sourceLocationId: sourceId,
          targetLocationId: deadTargetId,
          items: [{ inventoryEntryId: entryId, quantity: amount }],
        },
        TEST_ACTOR,
      ),
    ).rejects.toThrow(/does not exist or has been deleted/);
  });

  it("rejects creating inventory directly at Home", async () => {
    const { entityId: productId } = await liveProduct();

    await expect(
      createInventoryEntry(
        ctx.db,
        { productId, locationId: TEST_HOME_ID, amount },
        TEST_ACTOR,
      ),
    ).rejects.toThrow("Inventory cannot be placed directly at Home");
  });

  it("rejects moving inventory directly to Home", async () => {
    const { entityId: sourceId } = await liveLocation();
    const { entityId: productId } = await liveProduct();
    const { entityId: entryId } = await createTestEntry(productId, sourceId);

    await expect(
      updateInventoryEntry(
        ctx.db,
        entryId,
        { locationId: TEST_HOME_ID },
        TEST_ACTOR,
      ),
    ).rejects.toThrow("Inventory cannot be placed directly at Home");
    await expect(
      bulkMoveInventoryEntries(
        ctx.db,
        {
          sourceLocationId: sourceId,
          targetLocationId: TEST_HOME_ID,
          items: [{ inventoryEntryId: entryId, quantity: amount }],
        },
        TEST_ACTOR,
      ),
    ).rejects.toThrow("Inventory cannot be placed directly at Home");
  });

  it("rejects reconciling inventory directly at Home", async () => {
    const { entityId: productId } = await liveProduct();

    await expect(
      bulkProcessInventoryEntries(
        ctx.db,
        TEST_HOME_ID,
        [{ productId, locationId: TEST_HOME_ID, amount }],
        TEST_ACTOR,
      ),
    ).rejects.toThrow("Inventory cannot be placed directly at Home");
  });

  it("allows writes to live product + location (no false positives)", async () => {
    const { entityId: locationId } = await liveLocation();
    const { entityId: productId } = await liveProduct();

    const { output: entry, entityId: entryId } = await createTestEntry(
      productId,
      locationId,
    );
    expect(entry.id).toBeDefined();

    // A normal move to another live location succeeds.
    const { output: otherLocation, entityId: otherLocationId } =
      await createTestLocation("Pantry");
    const moved = await updateInventoryEntry(
      ctx.db,
      entryId,
      { locationId: otherLocationId },
      TEST_ACTOR,
    );
    expect(moved.location.id).toEqual(otherLocation.id);
  });
});
