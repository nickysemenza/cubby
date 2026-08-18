import {
  unsafeInventoryId,
  unsafeLocationId,
  unsafeProductId,
} from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { product } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import {
  createInventoryEntry,
  inventoryentryList,
  updateInventoryEntry,
} from "~/server/repo/inventory";
import {
  createLocation,
  ensureGlobalUnknownLocation,
} from "~/server/repo/location";
import { createProduct } from "~/server/repo/product";
import {
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";

// Repo-level coverage for the product-attribute filters added to
// `inventoryentryList` (manufacturerFilter / categoryFilter). The router-level
// test in `server/api/routers/inventory.integration.test.ts` only covers
// productNameFilter/locationNameFilter/locationIdFilter — this fills the gap,
// and in particular pins that the count/valuation aggregate (a second query
// sharing the same where clause) agrees with the filtered row set.
describe("inventoryentryList product-attribute filters", () => {
  const ctx = withTestDb();

  const requireResolvedId = async (
    shortcode: string,
    entity: "location" | "product" | "inventory",
  ) => {
    const entityId = await resolveLiveShortcode(ctx.db, shortcode, entity);
    if (!entityId) throw new Error(`Failed to resolve ${entity} ${shortcode}`);
    return entityId;
  };

  const createTestLocation = async (
    input: Parameters<typeof createLocation>[1],
  ) => {
    const output = await createLocation(ctx.db, input, TEST_ACTOR);
    return {
      // `locationIdFilter` now takes the PUBLIC code (the repo resolves it);
      // the write paths below still take the uuid.
      shortcode: output.id,
      entityId: unsafeLocationId(
        await requireResolvedId(output.id, "location"),
      ),
    };
  };

  const createTestProduct = async (
    input: Parameters<typeof createProduct>[1],
  ) => {
    const output = await createProduct(ctx.db, input, TEST_ACTOR);
    return {
      output,
      entityId: unsafeProductId(await requireResolvedId(output.id, "product")),
    };
  };

  const list = (filters: Parameters<typeof inventoryentryList>[1]) =>
    inventoryentryList(
      ctx.db,
      filters,
      [{ orderBy: "createdAt", direction: "asc" }],
      { pageSize: 50, pageIndex: 0 },
    );

  // The slot is `(productId, locationId, placement)`, so a spare on the shelf
  // and one wired into the wall legitimately coexist — which is exactly what
  // makes this collision reachable rather than a corrupt state. Without a
  // pre-check the partial unique index raises a raw 23505 and nothing maps that
  // to an AppError, so the operator sees an untranslated Postgres error.
  it("refuses a placement flip that would collide with an existing slot", async () => {
    const { entityId: locationId, shortcode: locationShortcode } =
      await createTestLocation(makeLocationInput({ name: "Kitchen" }));
    const { entityId: productId } = await createTestProduct(
      makeProductInput({ name: "Poetto faucet" }),
    );

    const spare = await createInventoryEntry(
      ctx.db,
      { productId, locationId, amount: { value: 1, unit: "each" } },
      TEST_ACTOR,
    );
    await createInventoryEntry(
      ctx.db,
      {
        productId,
        locationId,
        amount: { value: 1, unit: "each" },
        placement: "installed",
      },
      TEST_ACTOR,
    );

    const spareId = unsafeInventoryId(
      await requireResolvedId(spare.id, "inventory"),
    );

    await expect(
      updateInventoryEntry(
        ctx.db,
        spareId,
        { placement: "installed" },
        TEST_ACTOR,
      ),
    ).rejects.toThrow(/already sits at this location/);

    // And the refusal is clean: the spare is untouched, not half-written.
    const rows = await list({
      locationIdFilter: locationShortcode,
      placementFilter: "all",
    });
    expect(rows.data).toHaveLength(2);
  });

  it("manufacturerFilter matches case-insensitively on a substring", async () => {
    const { entityId: locationId } = await createTestLocation(
      makeLocationInput({ name: "Garage" }),
    );
    const { entityId: milwaukeeId } = await createTestProduct(
      makeProductInput({ name: "Drill", manufacturer: "Milwaukee" }),
    );
    const { entityId: dewaltId } = await createTestProduct(
      makeProductInput({ name: "Saw", manufacturer: "DeWalt" }),
    );
    await createInventoryEntry(
      ctx.db,
      {
        productId: milwaukeeId,
        locationId,
        amount: { value: 1, unit: "each" },
      },
      TEST_ACTOR,
    );
    await createInventoryEntry(
      ctx.db,
      {
        productId: dewaltId,
        locationId,
        amount: { value: 1, unit: "each" },
      },
      TEST_ACTOR,
    );

    const result = await list({ manufacturerFilter: "milwau" });

    expect(result.data.length).toEqual(1);
    expect(result.data[0]?.product.manufacturer).toEqual("Milwaukee");
    expect(result.count).toEqual(1);
  });

  it("filters the canonical global Unknown location by semantic role", async () => {
    const unknown = await ensureGlobalUnknownLocation(ctx.db, TEST_ACTOR);
    const other = await createTestLocation(
      makeLocationInput({ name: "Unknown-looking spare room" }),
    );
    const productRow = await createTestProduct(
      makeProductInput({ name: "Unfiled filter fixture" }),
    );
    await createInventoryEntry(
      ctx.db,
      {
        productId: productRow.entityId,
        locationId: unsafeLocationId(
          await requireResolvedId(unknown.id, "location"),
        ),
        amount: { value: 1, unit: "each" },
      },
      TEST_ACTOR,
    );
    await createInventoryEntry(
      ctx.db,
      {
        productId: productRow.entityId,
        locationId: other.entityId,
        amount: { value: 1, unit: "each" },
      },
      TEST_ACTOR,
    );

    const result = await list({
      placementFilter: "all",
      locationRole: "global_unknown",
    });

    expect(result.count).toBe(1);
    expect(result.data[0]?.location.id).toBe(unknown.id);
  });

  it("categoryFilter scopes to the matching category", async () => {
    const { entityId: locationId } = await createTestLocation(
      makeLocationInput({ name: "Shop" }),
    );
    const { entityId: toolId } = await createTestProduct(
      makeProductInput({ name: "Grinder", category: "tools" }),
    );
    const { entityId: hardwareId } = await createTestProduct(
      makeProductInput({ name: "Screws", category: "hardware" }),
    );
    await createInventoryEntry(
      ctx.db,
      {
        productId: toolId,
        locationId,
        amount: { value: 1, unit: "each" },
      },
      TEST_ACTOR,
    );
    await createInventoryEntry(
      ctx.db,
      {
        productId: hardwareId,
        locationId,
        amount: { value: 1, unit: "each" },
      },
      TEST_ACTOR,
    );

    const result = await list({ categoryFilter: "tools" });

    expect(result.data.length).toEqual(1);
    expect(result.data[0]?.product.category).toEqual("tools");
  });

  it("ANDs manufacturerFilter and categoryFilter rather than ORing them", async () => {
    const { entityId: locationId } = await createTestLocation(
      makeLocationInput({ name: "Basement" }),
    );
    // Matches manufacturer only.
    const milwaukeeHardware = await createTestProduct(
      makeProductInput({
        name: "Bolt Pack",
        manufacturer: "Milwaukee",
        category: "hardware",
      }),
    );
    // Matches category only.
    const otherTool = await createTestProduct(
      makeProductInput({
        name: "Wrench",
        manufacturer: "Craftsman",
        category: "tools",
      }),
    );
    // Matches both.
    const milwaukeeTool = await createTestProduct(
      makeProductInput({
        name: "Drill",
        manufacturer: "Milwaukee",
        category: "tools",
      }),
    );
    for (const p of [milwaukeeHardware, otherTool, milwaukeeTool]) {
      await createInventoryEntry(
        ctx.db,
        {
          productId: p.entityId,
          locationId,
          amount: { value: 1, unit: "each" },
        },
        TEST_ACTOR,
      );
    }

    const result = await list({
      manufacturerFilter: "milwaukee",
      categoryFilter: "tools",
    });

    expect(result.data.length).toEqual(1);
    expect(result.data[0]?.product.id).toEqual(milwaukeeTool.output.id);
  });

  it("the count/valuation aggregate agrees with the filtered row set", async () => {
    const { entityId: locationId } = await createTestLocation(
      makeLocationInput({ name: "Kitchen" }),
    );
    const { entityId: flourId } = await createTestProduct(
      makeProductInput({
        name: "Flour",
        manufacturer: "Bob's",
        category: "food",
        price: 5,
      }),
    );
    const { entityId: sugarId } = await createTestProduct(
      makeProductInput({
        name: "Sugar",
        manufacturer: "Bob's",
        category: "food",
        price: 3,
      }),
    );
    const { entityId: drillId } = await createTestProduct(
      makeProductInput({
        name: "Drill",
        manufacturer: "Milwaukee",
        category: "tools",
        price: 100,
      }),
    );
    await createInventoryEntry(
      ctx.db,
      {
        productId: flourId,
        locationId,
        amount: { value: 2, unit: "each" },
      },
      TEST_ACTOR,
    );
    await createInventoryEntry(
      ctx.db,
      {
        productId: sugarId,
        locationId,
        amount: { value: 4, unit: "each" },
      },
      TEST_ACTOR,
    );
    await createInventoryEntry(
      ctx.db,
      {
        productId: drillId,
        locationId,
        amount: { value: 1, unit: "each" },
      },
      TEST_ACTOR,
    );

    // Page size 1 so the returned page can't accidentally equal the full set —
    // the aggregate must reflect ALL matching rows, not just the page.
    const result = await inventoryentryList(
      ctx.db,
      { categoryFilter: "food" },
      [{ orderBy: "createdAt", direction: "asc" }],
      { pageSize: 1, pageIndex: 0 },
    );

    // 2 * 5 + 4 * 3 = 22, matching flour + sugar, NOT the drill.
    expect(result.data.length).toEqual(1);
    expect(result.count).toEqual(2);
    expect(result.sums.valuation).toEqual(22);
  });

  it("distinguishes an unpriceable stored unit from an unpriced product", async () => {
    const { entityId: locationId } = await createTestLocation(
      makeLocationInput({ name: "Valuation shelf" }),
    );
    const priced = await createTestProduct(
      makeProductInput({ name: "Priced pack", price: 20 }),
    );
    const unpriced = await createTestProduct(
      makeProductInput({ name: "Unpriced pack", price: null }),
    );
    const valued = await createTestProduct(
      makeProductInput({ name: "Valued each", price: 5 }),
    );
    const unpriceableEntry = await createInventoryEntry(
      ctx.db,
      {
        productId: priced.entityId,
        locationId,
        amount: { value: 2, unit: "roll" },
      },
      TEST_ACTOR,
    );
    await createInventoryEntry(
      ctx.db,
      {
        productId: unpriced.entityId,
        locationId,
        amount: { value: 1, unit: "each" },
      },
      TEST_ACTOR,
    );
    await createInventoryEntry(
      ctx.db,
      {
        productId: valued.entityId,
        locationId,
        amount: { value: 1, unit: "each" },
      },
      TEST_ACTOR,
    );

    const result = await list({
      placementFilter: "all",
      valuationStatus: "missing_with_priced_product",
    });

    expect(result.count).toBe(1);
    expect(result.data.map((row) => row.id)).toEqual([unpriceableEntry.id]);
  });

  it("a soft-deleted product does not leak an entry through the join", async () => {
    const { entityId: locationId } = await createTestLocation(
      makeLocationInput({ name: "Attic" }),
    );
    const { entityId: doomedId } = await createTestProduct(
      makeProductInput({
        name: "Old Sander",
        manufacturer: "Milwaukee",
        category: "tools",
      }),
    );
    const entry = await createInventoryEntry(
      ctx.db,
      {
        productId: doomedId,
        locationId,
        amount: { value: 1, unit: "each" },
      },
      TEST_ACTOR,
    );
    expect(entry.id).toBeDefined();

    // `deleteProducts` refuses a product with live inventory, so an inventory
    // row pointing at a soft-deleted product is only reachable via a direct
    // write (same pattern as location.integration.test.ts's orphan-shelf
    // guard). That's exactly the state the inner join must filter out —
    // reachable in practice via any path that soft-deletes a product without
    // going through the guarded repo function.
    await getDb(ctx.db)
      .update(product)
      .set({ deletedAt: new Date() })
      .where(eq(product.id, doomedId));

    const result = await list({ manufacturerFilter: "milwaukee" });
    expect(result.data.length).toEqual(0);
    expect(result.count).toEqual(0);
  });
});
