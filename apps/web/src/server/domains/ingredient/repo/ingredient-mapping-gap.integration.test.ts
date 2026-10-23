import { type VendorId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { writeProductConversionCoverageProjection } from "~/server/domains/product/repo/conversion-coverage";
import { findOrCreateVendor } from "~/server/domains/vendor/repo/vendor";
import {
  createProductIdentityFixture,
  createRecipeFixture,
  ingredientRef,
  makeProductInput,
  makeRecipeInput,
} from "~/server/testing/repo.fixtures";

import { findOrCreateIngredient } from "./crud";
import { ingredientList } from "./search";

describe("ingredient mappingGap filter", () => {
  const ctx = withTestDb();
  const firstPage = { pageIndex: 0, pageSize: 100 };

  const ingredientWith = async (
    name: string,
    products: readonly ("complete" | "partial" | "none-yet")[],
    brandId: VendorId,
  ) => {
    const ingredient = await findOrCreateIngredient(ctx.db, name);
    for (const [index, tier] of products.entries()) {
      const product = await createProductIdentityFixture(
        ctx.db,
        makeProductInput({
          name: `${name} product ${index}`,
          brandId,
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
    const brandId = await findOrCreateVendor(
      ctx.db,
      "Synthetic mapping-gap brand",
    );
    const [unmapped, covered, partial, mixed, unused] = await Promise.all([
      ingredientWith("Gap unmapped", [], brandId),
      ingredientWith("Gap covered", ["complete"], brandId),
      ingredientWith("Gap partial", ["partial"], brandId),
      ingredientWith("Gap mixed", ["partial", "complete"], brandId),
      ingredientWith("Gap unused", [], brandId),
    ]);
    // A product whose coverage was never computed is unknown, not complete.
    const unknown = await ingredientWith("Gap unknown", ["none-yet"], brandId);
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
      { mappingGap: true },
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
    // The flag is a boolean now: false is the complement, never-used included.
    const nonGap = (
      await ingredientList(
        ctx.db,
        { mappingGap: false },
        [{ orderBy: "name", direction: "asc" }],
        firstPage,
      )
    ).data.map((row) => row.name);
    expect(nonGap).toEqual(
      expect.arrayContaining(["Gap covered", "Gap mixed", unused.name]),
    );
    expect(nonGap).not.toContain("Gap partial");
  });
});
