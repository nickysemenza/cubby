import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "~/server/db";
import { buildTestDB } from "tooling/test-setup";
import { createCallerFactory, createTestTRPCContext } from "../trpc";
import { appRouter } from "../root";
import { type OrganizationId, unsafeUserId } from "~/schemas/identifiers";
import type { InventoryCSVRow } from "~/schemas/inventory";

const TEST_USER_ID = unsafeUserId("test-user-id");

// Test data in CSV format
const testCSVRows: InventoryCSVRow[] = [
  {
    product_name: "cilantro",
    manufacturer: "generic",
    quantity: 1,
    unit: "each",
    unit_mappings:
      "1 bunch = $2 @ whole foods; 1 bunch = 100sprig @ general; 1 bunch = 1each @ general",
    ingredient: true,
  },
  {
    product_name: "white sugar",
    manufacturer: "generic",
    quantity: 1,
    unit: "each",
    unit_mappings: "1 lb = $1 @ general",
    ingredient: true,
  },
  {
    product_name: "All Purpose Flour",
    manufacturer: "King Arthur",
    upc: "071012010509",
    quantity: 1,
    unit: "each",
    unit_mappings: "5 lb = $8 @ whole foods; 1 cup = 120g @ unk",
    aliases: "AP flour;flour;white flour;all-purpose flour",
    ingredient: true,
  },
  {
    product_name: "All Purpose Flour",
    manufacturer: "Bob's Red Mill",
    upc: "039978533012",
    quantity: 1,
    unit: "each",
    unit_mappings: "5 lb = $7 @ whole foods; 1 cup = 120g @ unk",
    aliases: "AP flour;flour;white flour;all-purpose flour",
    ingredient: true,
  },
  {
    product_name: "M18 Hackzall",
    manufacturer: "Milwaukee",
    upc: "045242502776",
    quantity: 1,
    unit: "each",
    price: 169,
    expected_qty: 1,
    ingredient: false,
  },
];

describe("CSV import test", () => {
  let db: Database;
  let organizationId: OrganizationId;
  let teardown: () => Promise<void>;
  beforeEach(async () => {
    ({ db, organizationId, teardown } = await buildTestDB());
    return teardown;
  });

  it("imports CSV data and creates ingredients", async () => {
    const createCaller = createCallerFactory(appRouter);
    const caller = createCaller(
      createTestTRPCContext(db, {
        auth: { userId: TEST_USER_ID },
        organizationId,
      }),
    );

    // Import CSV data
    const importResult = await caller.inventoryItem.importCSV({
      rows: testCSVRows,
    });

    expect(importResult.productOnly).toEqual(5); // All rows are product-only (no location)
    expect(importResult.errors).toEqual(0);

    // Verify ingredients were created
    const list = await caller.ingredient.list({
      pagination: { pageSize: 100 },
      filters: {},
    });
    // 3 unique ingredients: cilantro, white sugar, All Purpose Flour (deduplicated by alias)
    expect(list.items.length).toEqual(3);

    // Find ingredient by alias
    const ingredient = await caller.ingredient.getByName({
      nameFilter: "AP flour",
    });
    expect(ingredient).not.toBeNull();
    if (ingredient === null) {
      return;
    }
    expect(ingredient.name).toBe("All Purpose Flour");

    // Create a recipe with the ingredient
    const recipe = await caller.recipe.insertCompact({
      name: "test recipe",
      sections: [{ instructions: ["mix"], ingredients: ["AP flour"] }],
    });
    expect(recipe.id).toBeDefined();
    const recipe2 = await caller.recipe.getByID({ id: recipe.id });
    expect(recipe2.name).toBe("test recipe");
  });
});
