import type { IngredientShortcode } from "@cubby/schemas/identifiers";
import { and, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import type { Database } from "~/server/db";
import {
  ingredient,
  recipe,
  recipeSection,
  recipeSectionIngredient,
} from "~/server/db/schema";

import { getDb, notDeleted } from "./database-helpers";
import {
  deleteIngredients,
  getIngredientByID,
  ingredientList,
} from "./ingredient";
import { deleteRecipes } from "./recipe";
import {
  createIngredientFixture as createIngredient,
  createRecipeFixture as createRecipe,
  ingredientRef,
  makeRecipeInput,
} from "./repo.fixtures";

// Invariant: a soft-deleted recipe must vanish from EVERY "appears in N recipes"
// surface at once. These are computed by three independent mechanisms (the
// `appearsInRecipes` relation transform, the shared `liveRecipeCountForIngredientSql`
// subquery used by the list sort + global search, and the cascade itself), so this
// test guards against either one drifting — the bug where an ingredient used
// only in a deleted recipe still showed a recipe pill / non-zero count.

// Read the list-sort pill array, which sorts on
// `liveRecipeCountForIngredientSql`.
const appearsInRecipesFromList = async (
  db: Database,
  ingredientId: IngredientShortcode,
) => {
  const { data } = await ingredientList(
    db,
    {},
    [{ orderBy: "appearsInRecipes", direction: "desc" }],
    { pageIndex: 0, pageSize: 50 },
  );
  return data.find((i) => i.id === ingredientId)?.appearsInRecipes ?? [];
};

describe("soft-deleted recipes stay out of ingredient recipe counts", () => {
  const ctx = withTestDb();

  it("drops the ingredient's recipe count to zero across all surfaces when its only recipe is deleted", async () => {
    const ing = await createIngredient(
      ctx.db,
      { name: "Soledad pepper", aliases: [] },
      ctx.actor,
    );
    const ingredientId = ing.entityId;
    const ingredientCode = ing.id;

    const created = await createRecipe(
      ctx.db,
      makeRecipeInput({
        name: "Lone Pepper Stew",
        sections: [
          {
            name: "Main",
            instructions: [{ instruction: "Simmer" }],
            ingredients: [
              ingredientRef(ingredientCode, {
                amounts: [{ value: 1, unit: "cup" }],
              }),
            ],
          },
        ],
      }),
      ctx.actor,
    );

    // Baseline: the ingredient appears in exactly one recipe everywhere.
    expect(
      (await getIngredientByID(ctx.db, ingredientId)).appearsInRecipes,
    ).toHaveLength(1);
    expect(await appearsInRecipesFromList(ctx.db, ingredientCode)).toHaveLength(
      1,
    );

    await deleteRecipes(ctx.db, [created.entityId], ctx.actor);

    // After soft-deleting the only recipe, every surface reads zero.
    expect(
      (await getIngredientByID(ctx.db, ingredientId)).appearsInRecipes,
    ).toHaveLength(0);
    expect(
      (await getIngredientByID(ctx.db, ingredientId)).recipeUsages,
    ).toHaveLength(0);
    expect(await appearsInRecipesFromList(ctx.db, ingredientCode)).toHaveLength(
      0,
    );

    // Data invariant: no live section/usage row may reference the dead recipe.
    const liveSections = await getDb(ctx.db)
      .select({ id: recipeSection.id })
      .from(recipeSection)
      .where(
        and(
          eq(recipeSection.recipeId, created.entityId),
          notDeleted(recipeSection),
        ),
      );
    expect(liveSections).toHaveLength(0);

    const liveUsages = await getDb(ctx.db)
      .select({ id: recipeSectionIngredient.id })
      .from(recipeSectionIngredient)
      .innerJoin(
        recipeSection,
        eq(recipeSection.id, recipeSectionIngredient.recipeSectionId),
      )
      .where(
        and(
          eq(recipeSection.recipeId, created.entityId),
          notDeleted(recipeSectionIngredient),
        ),
      );
    expect(liveUsages).toHaveLength(0);
  });

  it("ignores stale live usages whose recipe was deleted without cascading", async () => {
    // Reproduces the original bug's data shape: pre-cascade deletions left the
    // section/usage rows LIVE while the recipe row was soft-deleted. The read-side
    // filters (shared count subquery + the dbIngredientToAPI recipe.deletedAt
    // backstop) must still report zero despite the live usage row.
    const ing = await createIngredient(
      ctx.db,
      { name: "Orphan oregano", aliases: [] },
      ctx.actor,
    );
    const ingredientId = ing.entityId;
    const ingredientCode = ing.id;

    const created = await createRecipe(
      ctx.db,
      makeRecipeInput({
        name: "Orphaned Recipe",
        sections: [
          {
            name: "Main",
            instructions: [{ instruction: "Mix" }],
            ingredients: [
              ingredientRef(ingredientCode, {
                amounts: [{ value: 1, unit: "cup" }],
              }),
            ],
          },
        ],
      }),
      ctx.actor,
    );

    // Soft-delete ONLY the recipe row, leaving its section + usage rows live.
    await getDb(ctx.db)
      .update(recipe)
      .set({ deletedAt: new Date() })
      .where(eq(recipe.id, created.entityId));

    expect(
      (await getIngredientByID(ctx.db, ingredientId)).appearsInRecipes,
    ).toHaveLength(0);
    expect(await appearsInRecipesFromList(ctx.db, ingredientCode)).toHaveLength(
      0,
    );
  });
});

describe("ingredient delete guard agrees with the live recipe count", () => {
  const ctx = withTestDb();

  it("allows deleting an ingredient whose only usage is in a soft-deleted recipe", async () => {
    // Same orphan shape as above: recipe soft-deleted without cascading, so a
    // live usage row dangles. The guard must NOT block deletion — its liveness
    // filter must match the (zero) recipe count the read surfaces report.
    const ing = await createIngredient(
      ctx.db,
      { name: "Orphan tarragon", aliases: [] },
      ctx.actor,
    );
    const ingredientId = ing.entityId;
    const ingredientCode = ing.id;

    const created = await createRecipe(
      ctx.db,
      makeRecipeInput({
        name: "Orphaned Guard Recipe",
        sections: [
          {
            name: "Main",
            instructions: [{ instruction: "Mix" }],
            ingredients: [
              ingredientRef(ingredientCode, {
                amounts: [{ value: 1, unit: "cup" }],
              }),
            ],
          },
        ],
      }),
      ctx.actor,
    );

    // Soft-delete ONLY the recipe row, leaving its section + usage rows live.
    await getDb(ctx.db)
      .update(recipe)
      .set({ deletedAt: new Date() })
      .where(eq(recipe.id, created.entityId));

    await expect(
      deleteIngredients(ctx.db, [ingredientId], ctx.actor),
    ).resolves.toMatchObject({ deleted: 1 });

    // The ingredient row is now soft-deleted.
    const [row] = await getDb(ctx.db)
      .select({ deletedAt: ingredient.deletedAt })
      .from(ingredient)
      .where(eq(ingredient.id, ingredientId));
    expect(row?.deletedAt).not.toBeNull();
  });

  it("still blocks deleting an ingredient used in a live recipe", async () => {
    const ing = await createIngredient(
      ctx.db,
      { name: "Live thyme", aliases: [] },
      ctx.actor,
    );
    const ingredientId = ing.entityId;
    const ingredientCode = ing.id;

    await createRecipe(
      ctx.db,
      makeRecipeInput({
        name: "Live Guard Recipe",
        sections: [
          {
            name: "Main",
            instructions: [{ instruction: "Mix" }],
            ingredients: [
              ingredientRef(ingredientCode, {
                amounts: [{ value: 1, unit: "cup" }],
              }),
            ],
          },
        ],
      }),
      ctx.actor,
    );

    await expect(
      deleteIngredients(ctx.db, [ingredientId], ctx.actor),
    ).rejects.toThrow(/used in recipes/);
  });
});
