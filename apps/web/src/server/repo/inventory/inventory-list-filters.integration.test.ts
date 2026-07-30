import { eq } from "drizzle-orm";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { product } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import {
  createInventoryEntry,
  inventoryentryList,
} from "~/server/repo/inventory";
import { createLocation } from "~/server/repo/location";
import { createProduct } from "~/server/repo/product";
import {
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";

// Repo-level coverage for the product-attribute filters added to
// `inventoryentryList` (manufacturerFilter / categoryFilter). The router-level
// test in `server/api/routers/inventory.integration.test.ts` only covers
// productNameFilter/locationNameFilter/locationIdFilter — this fills the gap,
// and in particular pins that the count/valuation aggregate (a second query
// sharing the same where clause) agrees with the filtered row set.
describe("inventoryentryList product-attribute filters", () => {
  const ctx = withTestDb();

  const list = (filters: Parameters<typeof inventoryentryList>[1]) =>
    inventoryentryList(
      ctx.db,
      filters,
      [{ orderBy: "createdAt", direction: "asc" }],
      { pageSize: 50, pageIndex: 0 },
    );

  it("manufacturerFilter matches case-insensitively on a substring", async () => {
    const location = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Garage" }),
      TEST_ACTOR,
    );
    const milwaukee = await createProduct(
      ctx.db,
      makeProductInput({ name: "Drill", manufacturer: "Milwaukee" }),
      TEST_ACTOR,
    );
    const dewalt = await createProduct(
      ctx.db,
      makeProductInput({ name: "Saw", manufacturer: "DeWalt" }),
      TEST_ACTOR,
    );
    await createInventoryEntry(
      ctx.db,
      {
        productId: milwaukee.id,
        locationId: location.id,
        amount: { value: 1, unit: "each" },
      },
      TEST_ACTOR,
    );
    await createInventoryEntry(
      ctx.db,
      {
        productId: dewalt.id,
        locationId: location.id,
        amount: { value: 1, unit: "each" },
      },
      TEST_ACTOR,
    );

    const result = await list({ manufacturerFilter: "milwau" });

    expect(result.data.length).toEqual(1);
    expect(result.data[0]?.product.manufacturer).toEqual("Milwaukee");
    expect(result.count).toEqual(1);
  });

  it("categoryFilter scopes to the matching category", async () => {
    const location = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Shop" }),
      TEST_ACTOR,
    );
    const tool = await createProduct(
      ctx.db,
      makeProductInput({ name: "Grinder", category: "tools" }),
      TEST_ACTOR,
    );
    const hardware = await createProduct(
      ctx.db,
      makeProductInput({ name: "Screws", category: "hardware" }),
      TEST_ACTOR,
    );
    await createInventoryEntry(
      ctx.db,
      {
        productId: tool.id,
        locationId: location.id,
        amount: { value: 1, unit: "each" },
      },
      TEST_ACTOR,
    );
    await createInventoryEntry(
      ctx.db,
      {
        productId: hardware.id,
        locationId: location.id,
        amount: { value: 1, unit: "each" },
      },
      TEST_ACTOR,
    );

    const result = await list({ categoryFilter: "tools" });

    expect(result.data.length).toEqual(1);
    expect(result.data[0]?.product.category).toEqual("tools");
  });

  it("ANDs manufacturerFilter and categoryFilter rather than ORing them", async () => {
    const location = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Basement" }),
      TEST_ACTOR,
    );
    // Matches manufacturer only.
    const milwaukeeHardware = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Bolt Pack",
        manufacturer: "Milwaukee",
        category: "hardware",
      }),
      TEST_ACTOR,
    );
    // Matches category only.
    const otherTool = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Wrench",
        manufacturer: "Craftsman",
        category: "tools",
      }),
      TEST_ACTOR,
    );
    // Matches both.
    const milwaukeeTool = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Drill",
        manufacturer: "Milwaukee",
        category: "tools",
      }),
      TEST_ACTOR,
    );
    for (const p of [milwaukeeHardware, otherTool, milwaukeeTool]) {
      await createInventoryEntry(
        ctx.db,
        {
          productId: p.id,
          locationId: location.id,
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
    expect(result.data[0]?.product.id).toEqual(milwaukeeTool.id);
  });

  it("the count/valuation aggregate agrees with the filtered row set", async () => {
    const location = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Kitchen" }),
      TEST_ACTOR,
    );
    const flour = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Flour",
        manufacturer: "Bob's",
        category: "food",
        price: 5,
      }),
      TEST_ACTOR,
    );
    const sugar = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Sugar",
        manufacturer: "Bob's",
        category: "food",
        price: 3,
      }),
      TEST_ACTOR,
    );
    const drill = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Drill",
        manufacturer: "Milwaukee",
        category: "tools",
        price: 100,
      }),
      TEST_ACTOR,
    );
    await createInventoryEntry(
      ctx.db,
      {
        productId: flour.id,
        locationId: location.id,
        amount: { value: 2, unit: "each" },
      },
      TEST_ACTOR,
    );
    await createInventoryEntry(
      ctx.db,
      {
        productId: sugar.id,
        locationId: location.id,
        amount: { value: 4, unit: "each" },
      },
      TEST_ACTOR,
    );
    await createInventoryEntry(
      ctx.db,
      {
        productId: drill.id,
        locationId: location.id,
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

  it("a soft-deleted product does not leak an entry through the join", async () => {
    const location = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Attic" }),
      TEST_ACTOR,
    );
    const doomed = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Old Sander",
        manufacturer: "Milwaukee",
        category: "tools",
      }),
      TEST_ACTOR,
    );
    const entry = await createInventoryEntry(
      ctx.db,
      {
        productId: doomed.id,
        locationId: location.id,
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
      .where(eq(product.id, doomed.id));

    const result = await list({ manufacturerFilter: "milwaukee" });
    expect(result.data.length).toEqual(0);
    expect(result.count).toEqual(0);
  });
});
