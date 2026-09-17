import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { createIngredient } from "~/server/repo/ingredient";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";

import { productList } from ".";

/**
 * `ingredientIdFilter` (the SKU's own ingredient) and `growsIngredientIdFilter`
 * (the crop this product seeds — the Product↔Ingredient "grows" relation) are
 * independent shortcode-resolved id filters on `buildProductWhere`; each must
 * narrow by its own column, not the other's.
 */
describe("productList id filters", () => {
  const ctx = withTestDb();

  it("ingredientIdFilter narrows to products whose own ingredientId matches, leaving growsIngredientId-only matches out", async () => {
    const flour = await createIngredient(
      ctx.db,
      { name: "Filter flour" },
      TEST_ACTOR,
    );
    const tomato = await createIngredient(
      ctx.db,
      { name: "Filter tomato crop" },
      TEST_ACTOR,
    );
    const flourBag = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Flour bag", ingredientId: flour.id }),
      TEST_ACTOR,
    );
    const tomatoSeeds = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Tomato seed packet",
        growsIngredientId: tomato.id,
      }),
      TEST_ACTOR,
    );

    const { data } = await productList(
      ctx.db,
      { ingredientIdFilter: flour.id },
      [],
      { pageIndex: 0, pageSize: 50 },
    );
    const ids = new Set(data.map((row) => row.id));
    expect(ids.has(flourBag.id)).toBe(true);
    expect(ids.has(tomatoSeeds.id)).toBe(false);
  });

  it("growsIngredientIdFilter narrows to products whose growsIngredientId matches, leaving ingredientId-only matches out", async () => {
    const flour = await createIngredient(
      ctx.db,
      { name: "Filter flour 2" },
      TEST_ACTOR,
    );
    const tomato = await createIngredient(
      ctx.db,
      { name: "Filter tomato crop 2" },
      TEST_ACTOR,
    );
    const flourBag = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Flour bag 2", ingredientId: flour.id }),
      TEST_ACTOR,
    );
    const tomatoSeeds = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Tomato seed packet 2",
        growsIngredientId: tomato.id,
      }),
      TEST_ACTOR,
    );

    const { data } = await productList(
      ctx.db,
      { growsIngredientIdFilter: tomato.id },
      [],
      { pageIndex: 0, pageSize: 50 },
    );
    const ids = new Set(data.map((row) => row.id));
    expect(ids.has(tomatoSeeds.id)).toBe(true);
    expect(ids.has(flourBag.id)).toBe(false);
  });
});
