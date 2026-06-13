import type { ActorContext } from "@cubby/schemas/context";
import { unsafeIngredientId, unsafeUserId } from "@cubby/schemas/identifiers";
import type { RecipeCreateInput } from "@cubby/schemas/recipe";
import { buildTestDB } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "~/server/db";
import { createIngredient } from "./ingredient";
import { createRecipe, getRecipeByID, updateRecipe } from "./recipe";

const TEST_ACTOR: ActorContext = {
  userId: unsafeUserId("test-user-id"),
  source: "ui",
};

/**
 * Regression test: sections (and ingredients within a section) must round-trip
 * in the order they were submitted. Before `sortOrder` existed, the read path
 * had no ORDER BY, so Postgres returned them in plan-dependent (often reversed)
 * order — and createdAt can't break ties because every row in one save shares
 * the transaction timestamp.
 */
describe("recipe section ordering", () => {
  let db: Database;
  let teardown: () => Promise<void>;

  let ingredientIds: string[] = [];

  beforeEach(async () => {
    ({ db, teardown } = await buildTestDB());

    ingredientIds = [];
    for (const name of ["Flour", "Sugar", "Butter", "Salt"]) {
      const created = await createIngredient(
        db,
        { name, aliases: [] },
        TEST_ACTOR,
      );
      ingredientIds.push(created.id);
    }

    return teardown;
  });

  const ingredientInput = (id: string) => ({
    type: "ingredient" as const,
    ingredientId: unsafeIngredientId(id),
    recipeId: null,
    amounts: [{ value: 1, unit: "cup" }],
  });

  const buildInput = (): RecipeCreateInput => ({
    name: "Ordered Recipe",
    meta: { url: null },
    sections: ["Section A", "Section B", "Section C"].map((name, i) => ({
      name,
      instructions: [{ instruction: `Step for ${name}` }],
      ingredients: [
        ingredientInput(ingredientIds[i]!),
        ingredientInput(ingredientIds[i + 1]!),
      ],
    })),
  });

  it("returns sections and ingredients in the order they were created", async () => {
    const created = await createRecipe(db, buildInput(), TEST_ACTOR);

    const found = await getRecipeByID(db, created.id);

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
    const created = await createRecipe(db, buildInput(), TEST_ACTOR);
    const id = created.id;

    // Reorder existing sections (by id) to C, A, B
    const byName = new Map(created.sections.map((s) => [s.name, s]));
    await updateRecipe(
      db,
      id,
      {
        sections: ["Section C", "Section A", "Section B"].map((name) => ({
          id: byName.get(name)!.id,
          name,
        })),
      },
      TEST_ACTOR,
    );

    const found = await getRecipeByID(db, id);
    expect(found!.sections.map((s) => s.name)).toEqual([
      "Section C",
      "Section A",
      "Section B",
    ]);
  });

  it("persists an ingredient reorder within a section on update", async () => {
    const created = await createRecipe(db, buildInput(), TEST_ACTOR);
    const id = created.id;

    const firstSection = created.sections[0]!;
    const reversed = [...firstSection.ingredients].reverse();
    await updateRecipe(
      db,
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
      TEST_ACTOR,
    );

    const found = await getRecipeByID(db, id);
    expect(
      found!.sections[0]!.ingredients.map((i) => i.ingredient!.id),
    ).toEqual(reversed.map((i) => i.ingredient!.id));
    // Other sections untouched
    expect(
      found!.sections[1]!.ingredients.map((i) => i.ingredient!.id),
    ).toEqual([ingredientIds[1], ingredientIds[2]]);
  });
});
