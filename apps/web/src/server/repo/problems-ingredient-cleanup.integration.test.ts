import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { ingredient } from "~/server/db/schema";
import { deleteUnusedIngredients } from "../services/problems.service";
import { getDb } from "./database-helpers";
import { findOrCreateIngredient } from "./ingredient";
import { createInventoryEntry } from "./inventory";
import { createLocation } from "./location";
import {
  findIngredientsWithUnusedAliases,
  findUnusedIngredients,
} from "./problems";
import { createProduct } from "./product";
import { upsertImportRecipe } from "./recipe";
import {
  makeImportRecipe,
  makeLocationInput,
  makeProductInput,
} from "./repo.fixtures";

describe("findUnusedIngredients", () => {
  const ctx = withTestDb();

  it("splits unused ingredients by product link, excluding in-recipe and sub-recipe ones", async () => {
    // In-recipe ingredient → never "unused".
    await upsertImportRecipe(
      makeImportRecipe({
        meta: { title: "soup" },
        sections: [{ instructions: ["stir"], ingredients: ["carrot"] }],
      }),
      ctx.db,
      ctx.actor,
    );

    // Unused, no product.
    await findOrCreateIngredient(ctx.db, "lonely spice");

    // Unused, linked to a product (no inventory).
    const withProd = await findOrCreateIngredient(ctx.db, "boxed thing");
    await createProduct(
      ctx.db,
      makeProductInput({ name: "Boxed", ingredientId: withProd.id }),
      ctx.actor,
    );

    // Sub-recipe pointer (recipeId set) → excluded even with no usage/product.
    const recipe = await upsertImportRecipe(
      makeImportRecipe({ meta: { title: "sub" } }),
      ctx.db,
      ctx.actor,
    );
    await getDb(ctx.db)
      .insert(ingredient)
      .values({ name: "Recipe: sub", recipeId: recipe.id });

    const { withProduct, withoutProduct } = await findUnusedIngredients(ctx.db);

    expect(withoutProduct.map((i) => i.name)).toEqual(["lonely spice"]);
    expect(withProduct.map((i) => i.name)).toEqual(["boxed thing"]);
    expect(withProduct[0]?.products.map((p) => p.name)).toEqual(["Boxed"]);
    // carrot (in-recipe) and "Recipe: sub" (pointer) are absent from both.
    const allNames = [...withProduct, ...withoutProduct].map((i) => i.name);
    expect(allNames).not.toContain("carrot");
    expect(allNames).not.toContain("Recipe: sub");
  });
});

describe("findIngredientsWithUnusedAliases", () => {
  const ctx = withTestDb();

  it("flags redundant and never-matched aliases, not recipe-matched ones", async () => {
    // "scallion" is used by a recipe line and resolves to this ingredient, so
    // the alias "scallion" is matched (kept); "bogus" never appears (flagged).
    await findOrCreateIngredient(ctx.db, "green onion", ["scallion", "bogus"]);
    await upsertImportRecipe(
      makeImportRecipe({
        meta: { title: "stirfry" },
        sections: [{ instructions: ["chop"], ingredients: ["scallion"] }],
      }),
      ctx.db,
      ctx.actor,
    );

    const flagged = await findIngredientsWithUnusedAliases(ctx.db);
    const row = flagged.find((f) => f.name === "green onion");
    expect(row).toBeDefined();
    expect(row?.unusedAliases).toEqual(["bogus"]);
    expect(row?.unusedAliases).not.toContain("scallion");
  });
});

describe("deleteUnusedIngredients", () => {
  const ctx = withTestDb();

  it("reports failure (not throw) when a linked product still has inventory", async () => {
    const ing = await findOrCreateIngredient(ctx.db, "stocked ingredient");
    const location = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Pantry" }),
      ctx.actor,
    );
    if (!location) throw new Error("location not created");
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: "Stocked", ingredientId: ing.id }),
      ctx.actor,
    );
    await createInventoryEntry(
      ctx.db,
      {
        productId: product.id,
        locationId: location.id,
        amount: { value: 1, unit: "each" },
      },
      ctx.actor,
    );

    const result = await deleteUnusedIngredients(
      ctx.db,
      [ing.id],
      true,
      ctx.actor,
    );
    expect(result.deleted).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.id).toBe(ing.id);

    // The ingredient survives the failed delete.
    const stillThere = await getDb(ctx.db).query.ingredient.findFirst({
      where: eq(ingredient.id, ing.id),
    });
    expect(stillThere?.deletedAt).toBeNull();
  });

  it("deletes the ingredient and its product when there's no inventory", async () => {
    const ing = await findOrCreateIngredient(ctx.db, "deletable ingredient");
    await createProduct(
      ctx.db,
      makeProductInput({ name: "Deletable", ingredientId: ing.id }),
      ctx.actor,
    );

    const result = await deleteUnusedIngredients(
      ctx.db,
      [ing.id],
      true,
      ctx.actor,
    );
    expect(result.deleted).toBe(1);
    expect(result.failed).toHaveLength(0);

    const gone = await getDb(ctx.db).query.ingredient.findFirst({
      where: eq(ingredient.id, ing.id),
    });
    expect(gone?.deletedAt).not.toBeNull();

    // No unused product-linked ingredient remains.
    const { withProduct } = await findUnusedIngredients(ctx.db);
    expect(withProduct.map((i) => i.name)).not.toContain(
      "deletable ingredient",
    );
  });
});
