import type { RecipeCreateInput } from "@cubby/schemas/recipe";
import { withTestDb } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";
import { createRecipe, getRecipeByID, updateRecipe } from "./recipe";
import { createIngredients, ingredientRef } from "./repo.fixtures";

/**
 * Regression test: sections (and ingredients within a section) must round-trip
 * in the order they were submitted. Before `sortOrder` existed, the read path
 * had no ORDER BY, so Postgres returned them in plan-dependent (often reversed)
 * order — and createdAt can't break ties because every row in one save shares
 * the transaction timestamp.
 */
describe("recipe section ordering", () => {
  const ctx = withTestDb();

  let ingredientIds: string[] = [];

  beforeEach(async () => {
    const created = await createIngredients(
      ctx.db,
      ["Flour", "Sugar", "Butter", "Salt"],
      ctx.actor,
    );
    ingredientIds = created.map((i) => i.id);
  });

  const buildInput = (): RecipeCreateInput => ({
    name: "Ordered Recipe",
    meta: { url: null },
    sections: ["Section A", "Section B", "Section C"].map((name, i) => ({
      name,
      instructions: [{ instruction: `Step for ${name}` }],
      ingredients: [
        ingredientRef(ingredientIds[i]!),
        ingredientRef(ingredientIds[i + 1]!),
      ],
    })),
  });

  it("returns sections and ingredients in the order they were created", async () => {
    const created = await createRecipe(ctx.db, buildInput(), ctx.actor);

    const found = await getRecipeByID(ctx.db, created.id);

    expect(found!.sections.map((s) => s.name)).toEqual([
      "Section A",
      "Section B",
      "Section C",
    ]);
    // Each section's ingredients keep their submitted order
    for (const [i, section] of found!.sections.entries()) {
      expect(section.ingredients.map((ing) => ing.ingredient!.id)).toEqual([
        ingredientIds[i],
        ingredientIds[i + 1],
      ]);
    }
  });

  it("persists a section reorder on update", async () => {
    const created = await createRecipe(ctx.db, buildInput(), ctx.actor);
    const id = created.id;

    // Reorder existing sections (by id) to C, A, B
    const byName = new Map(created.sections.map((s) => [s.name, s]));
    await updateRecipe(
      ctx.db,
      id,
      {
        sections: ["Section C", "Section A", "Section B"].map((name) => ({
          id: byName.get(name)!.id,
          name,
        })),
      },
      ctx.actor,
    );

    const found = await getRecipeByID(ctx.db, id);
    expect(found!.sections.map((s) => s.name)).toEqual([
      "Section C",
      "Section A",
      "Section B",
    ]);
  });

  it("persists an ingredient reorder within a section on update", async () => {
    const created = await createRecipe(ctx.db, buildInput(), ctx.actor);
    const id = created.id;

    const firstSection = created.sections[0]!;
    const reversed = [...firstSection.ingredients].reverse();
    await updateRecipe(
      ctx.db,
      id,
      {
        sections: created.sections.map((section) => ({
          id: section.id,
          ingredients: (section.id === firstSection.id
            ? reversed
            : section.ingredients
          ).map((ing) => ({
            id: ing.id,
            type: "ingredient" as const,
            ingredientId: ing.ingredient!.id,
            recipeId: null,
            amounts: ing.amounts,
          })),
        })),
      },
      ctx.actor,
    );

    const found = await getRecipeByID(ctx.db, id);
    expect(
      found!.sections[0]!.ingredients.map((i) => i.ingredient!.id),
    ).toEqual(reversed.map((i) => i.ingredient!.id));
    // Other sections untouched
    expect(
      found!.sections[1]!.ingredients.map((i) => i.ingredient!.id),
    ).toEqual([ingredientIds[1], ingredientIds[2]]);
  });
});
