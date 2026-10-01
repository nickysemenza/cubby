import { createRepoEntity } from "tooling/factories/repo";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  createIngredientFixture,
  createInventoryFixture,
  createLocationFixture,
  createProductFixture,
  createRecipeFixture,
  ingredientRef,
  makeLocationInput,
  makeProductInput,
  makeRecipeInput,
} from "~/server/repo/repo.fixtures";

import { findCoverageTotals } from "./detectors-coverage";

/**
 * The coverage meters' denominators. Each check-backed total counts the same
 * population its `dataGaps` filter scopes to (the check's `expected`), so the
 * "N of M" fraction compares one set; the two location totals are bespoke
 * populations. Asserted as deltas over an empty seed so the test states the
 * population rule rather than a fixture size.
 */
describe("coverage totals", () => {
  const ctx = withTestDb();

  it("counts each meter over its own population", async () => {
    const before = await findCoverageTotals(ctx.db);

    const shelf = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Coverage shelf" }),
      TEST_ACTOR,
    );
    // A stocked product is in scope for the image meter; an unstocked one is
    // not (`product_image` expects inventory).
    const stocked = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Coverage stocked" }),
      TEST_ACTOR,
    );
    await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Coverage unstocked" }),
      TEST_ACTOR,
    );
    // Movable stock counts toward the verification meter; an installed
    // fixture never gets verified, so it must not cap the meter below 100%.
    for (const placement of ["stock", "installed"] as const) {
      await createInventoryFixture(
        ctx.db,
        {
          productId: stocked.id,
          locationId: shelf.id,
          amount: { value: 1, unit: "each" },
          placement,
        },
        TEST_ACTOR,
      );
    }
    // An ingredient one of our own recipes uses is in scope for the product
    // link meter; an unused one is not.
    const used = await createIngredientFixture(
      ctx.db,
      { name: "Coverage used ingredient" },
      TEST_ACTOR,
    );
    await createIngredientFixture(
      ctx.db,
      { name: "Coverage unused ingredient" },
      TEST_ACTOR,
    );
    await createRecipeFixture(
      ctx.db,
      makeRecipeInput({
        name: "Coverage recipe",
        sections: [
          {
            instructions: [{ instruction: "Mix" }],
            ingredients: [ingredientRef(used.id)],
          },
        ],
      }),
      TEST_ACTOR,
    );
    // A vendor counts only once it has a live purchase.
    const transacted = await createRepoEntity(ctx, "vendor", {
      name: "Coverage transacted vendor",
    });
    await createRepoEntity(ctx, "vendor", { name: "Coverage idle vendor" });
    await createRepoEntity(ctx, "purchase", {
      date: "2026-08-01",
      vendorId: transacted.output.id,
    });

    const after = await findCoverageTotals(ctx.db);
    const delta = (key: keyof typeof after) => after[key] - before[key];

    expect(delta("productsWithNoImages")).toBe(1);
    expect(delta("neverVerifiedInventory")).toBe(1);
    expect(delta("ingredientsWithoutProduct")).toBe(1);
    expect(delta("vendorsWithPurchases")).toBe(1);
    // A parentless location is filed under the seeded "Home" root, so the new
    // shelf becomes the leaf and Home stops being one: the leaf count is flat.
    expect(delta("emptyLocations")).toBe(0);
    // The stocked shelf is the one new location holding live stock.
    expect(delta("staleLocations")).toBe(1);
  });
});
