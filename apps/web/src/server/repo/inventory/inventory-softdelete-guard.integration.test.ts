import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import {
  createInventoryEntry,
  updateInventoryEntry,
} from "~/server/repo/inventory";
import { createLocation, deleteLocations } from "~/server/repo/location";
import { createProduct, deleteProducts } from "~/server/repo/product";
import {
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";

// Regression guard for the soft-delete leak fixed in Sweep 2:
// inventory writes must reject a product/location that's been soft-deleted, so a
// live entry can never reference a "gone" parent (which previously leaked into
// global search — see repo/search.ts). A product/location with no inventory can
// be soft-deleted, so this state is reachable without the guard.
describe("inventory soft-delete target guard", () => {
  const ctx = withTestDb();

  const liveLocation = () =>
    createLocation(ctx.db, makeLocationInput({ name: "Shelf" }), TEST_ACTOR);
  const liveProduct = () =>
    createProduct(ctx.db, makeProductInput({ name: "Flour" }), TEST_ACTOR);
  const amount = { value: 1, unit: "lbs" };

  it("createInventoryEntry rejects a soft-deleted product", async () => {
    const location = await liveLocation();
    const product = await liveProduct();
    // No inventory yet, so the product can be soft-deleted.
    await deleteProducts(ctx.db, [product.id], TEST_ACTOR);

    await expect(
      createInventoryEntry(
        ctx.db,
        { productId: product.id, locationId: location.id, amount },
        TEST_ACTOR,
      ),
    ).rejects.toThrow(/does not exist or has been deleted/);
  });

  it("createInventoryEntry rejects a soft-deleted location", async () => {
    const location = await liveLocation();
    const product = await liveProduct();
    await deleteLocations(ctx.db, [location.id], TEST_ACTOR);

    await expect(
      createInventoryEntry(
        ctx.db,
        { productId: product.id, locationId: location.id, amount },
        TEST_ACTOR,
      ),
    ).rejects.toThrow(/does not exist or has been deleted/);
  });

  it("updateInventoryEntry rejects re-pointing at a soft-deleted product", async () => {
    const location = await liveLocation();
    const product = await liveProduct();
    const entry = await createInventoryEntry(
      ctx.db,
      { productId: product.id, locationId: location.id, amount },
      TEST_ACTOR,
    );

    // A second product with no inventory can be soft-deleted, then can't be
    // moved onto the live entry.
    const deadProduct = await createProduct(
      ctx.db,
      makeProductInput({ name: "Sugar" }),
      TEST_ACTOR,
    );
    await deleteProducts(ctx.db, [deadProduct.id], TEST_ACTOR);

    await expect(
      updateInventoryEntry(
        ctx.db,
        entry.id,
        { productId: deadProduct.id },
        TEST_ACTOR,
      ),
    ).rejects.toThrow(/does not exist or has been deleted/);
  });

  it("allows writes to live product + location (no false positives)", async () => {
    const location = await liveLocation();
    const product = await liveProduct();

    const entry = await createInventoryEntry(
      ctx.db,
      { productId: product.id, locationId: location.id, amount },
      TEST_ACTOR,
    );
    expect(entry.id).toBeDefined();

    // A normal move to another live location succeeds.
    const otherLocation = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Pantry" }),
      TEST_ACTOR,
    );
    const moved = await updateInventoryEntry(
      ctx.db,
      entry.id,
      { locationId: otherLocation.id },
      TEST_ACTOR,
    );
    expect(moved.location.id).toEqual(otherLocation.id);
  });
});
