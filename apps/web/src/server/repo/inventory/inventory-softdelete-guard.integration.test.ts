import { parseEntityId } from "@cubby/schemas/identifiers";
import { TEST_ACTOR, TEST_HOME_ID, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { createInventoryEntry } from "~/server/repo/inventory";
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
      entityId: parseEntityId(
        "location",
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
      entityId: parseEntityId(
        "product",
        await requireResolvedId(output.id, "product"),
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
});
