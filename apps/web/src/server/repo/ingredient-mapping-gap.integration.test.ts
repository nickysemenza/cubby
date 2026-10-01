import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { findOrCreateIngredient } from "./ingredient/crud";
import { ingredientList } from "./ingredient/search";
import { writeProductConversionCoverageProjection } from "./product/conversion-coverage";
import {
  createProductFixture,
  createRecipeFixture,
  ingredientRef,
  makeProductInput,
  makeRecipeInput,
} from "./repo.fixtures";

describe("ingredient mappingGap filter", () => {
  const ctx = withTestDb();
  const firstPage = { pageIndex: 0, pageSize: 100 };

  const ingredientWith = async (
    name: string,
    products: readonly ("complete" | "partial" | "none-yet")[],
  ) => {
    const ingredient = await findOrCreateIngredient(ctx.db, name);
    for (const [index, tier] of products.entries()) {
      const product = await createProductFixture(
        ctx.db,
        makeProductInput({
          name: `${name} product ${index}`,
          manufacturer: "test",
          ingredientId: parseShortcodeFor("ingredient", ingredient.shortcode),
        }),
        ctx.actor,
      );
      if (tier !== "none-yet")
        await writeProductConversionCoverageProjection(ctx.db, [
          {
            productId: product.entityId,
            coverageTier: tier,
            coveredKinds: [],
            applicableKinds: [],
            islandCount: 1,
            status: "ready",
          },
        ]);
    }
    return ingredient;
  };

  it("lists ingredients a live recipe needs that no complete product covers", async () => {
    const [unmapped, covered, partial, mixed, unused] = await Promise.all([
      ingredientWith("Gap unmapped", []),
      ingredientWith("Gap covered", ["complete"]),
      ingredientWith("Gap partial", ["partial"]),
      ingredientWith("Gap mixed", ["partial", "complete"]),
      ingredientWith("Gap unused", []),
    ]);
    // A product whose coverage was never computed is unknown, not complete.
    const unknown = await ingredientWith("Gap unknown", ["none-yet"]);
    await createRecipeFixture(
      ctx.db,
      makeRecipeInput({
        name: "Gap recipe",
        sections: [
          {
            ingredients: [unmapped, covered, partial, mixed, unknown].map(
              (ingredient) => ingredientRef(ingredient.shortcode),
            ),
            instructions: [{ instruction: "Combine" }],
          },
        ],
      }),
      ctx.actor,
    );

    const gap = await ingredientList(
      ctx.db,
      { mappingGap: "gap" },
      [{ orderBy: "name", direction: "asc" }],
      firstPage,
    );
    expect(gap.data.map((row) => row.name)).toEqual([
      "Gap partial",
      "Gap unknown",
      "Gap unmapped",
    ]);
    // Never-used ingredients are not a costing gap; nor are covered ones.
    const names = gap.data.map((row) => row.name);
    expect(names).not.toContain(unused.name);
    expect(names).not.toContain("Gap covered");
    expect(names).not.toContain("Gap mixed");
  });
});
