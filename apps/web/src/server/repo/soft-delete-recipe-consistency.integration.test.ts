import type { ActorContext } from "@cubby/schemas/context";
import type { IngredientId, RecipeId } from "@cubby/schemas/identifiers";
import { and, eq } from "drizzle-orm";
import { buildTestDB } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "~/server/db";
import {
  recipe,
  recipeSection,
  recipeSectionIngredient,
} from "~/server/db/schema";
import { getDb, notDeleted } from "./database-helpers";
import {
  createIngredient,
  getIngredientByID,
  ingredientList,
} from "./ingredient";
import { createRecipe, deleteRecipes } from "./recipe";
import { ingredientRef, makeRecipeInput } from "./repo.fixtures";
import { globalSearch } from "./search";

// Invariant: a soft-deleted recipe must vanish from EVERY "appears in N recipes"
// surface at once. These are computed by three independent mechanisms (the
// `appearsInRecipes` relation transform, the shared `liveRecipeCountForIngredientSql`
// subquery used by the list sort + global search, and the cascade itself), so this
// test guards against any one of them drifting — the bug where an ingredient used
// only in a deleted recipe still showed a recipe pill / non-zero count.

describe("soft-deleted recipes stay out of ingredient recipe counts", () => {
  let db: Database;
  let actor: ActorContext;
  let teardown: () => Promise<void>;

  beforeEach(async () => {
    ({ db, actor, teardown } = await buildTestDB());
    return teardown;
  });

  it("drops the ingredient's recipe count to zero across all surfaces when its only recipe is deleted", async () => {
    const ing = await createIngredient(
      db,
      { name: "Soledad pepper", aliases: [] },
      actor,
    );
    const ingredientId = ing.id as IngredientId;

    const created = await createRecipe(
      db,
      makeRecipeInput({
        name: "Lone Pepper Stew",
        sections: [
          {
            name: "Main",
            instructions: [{ instruction: "Simmer" }],
            ingredients: [
              ingredientRef(ingredientId, {
                amounts: [{ value: 1, unit: "cup" }],
              }),
            ],
          },
        ],
      }),
      actor,
    );

    const recipeCountFromSearch = async () => {
      const results = await globalSearch(db, "Soledad pepper");
      const hit = results.find(
        (r) => r.entityType === "ingredient" && r.id === ingredientId,
      );
      return hit && "recipeCount" in hit ? hit.recipeCount : undefined;
    };
    const pillsFromList = async () => {
      const { data } = await ingredientList(
        db,
        undefined,
        { orderBy: "appearsInRecipes", direction: "desc" },
        { pageIndex: 0, pageSize: 50 },
      );
      return data.find((i) => i.id === ingredientId)?.appearsInRecipes ?? [];
    };

    // Baseline: the ingredient appears in exactly one recipe everywhere.
    expect(
      (await getIngredientByID(db, ingredientId)).appearsInRecipes,
    ).toHaveLength(1);
    expect(await pillsFromList()).toHaveLength(1);
    expect(await recipeCountFromSearch()).toBe(1);

    await deleteRecipes(db, [created.id as RecipeId], actor);

    // After soft-deleting the only recipe, every surface reads zero.
    expect(
      (await getIngredientByID(db, ingredientId)).appearsInRecipes,
    ).toHaveLength(0);
    expect(
      (await getIngredientByID(db, ingredientId)).recipeUsages,
    ).toHaveLength(0);
    expect(await pillsFromList()).toHaveLength(0);
    expect(await recipeCountFromSearch()).toBe(0);

    // Data invariant: no live section/usage row may reference the dead recipe.
    const liveSections = await getDb(db)
      .select({ id: recipeSection.id })
      .from(recipeSection)
      .where(
        and(eq(recipeSection.recipeId, created.id), notDeleted(recipeSection)),
      );
    expect(liveSections).toHaveLength(0);

    const liveUsages = await getDb(db)
      .select({ id: recipeSectionIngredient.id })
      .from(recipeSectionIngredient)
      .innerJoin(
        recipeSection,
        eq(recipeSection.id, recipeSectionIngredient.recipeSectionId),
      )
      .where(
        and(
          eq(recipeSection.recipeId, created.id),
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
      db,
      { name: "Orphan oregano", aliases: [] },
      actor,
    );
    const ingredientId = ing.id as IngredientId;

    const created = await createRecipe(
      db,
      makeRecipeInput({
        name: "Orphaned Recipe",
        sections: [
          {
            name: "Main",
            instructions: [{ instruction: "Mix" }],
            ingredients: [
              ingredientRef(ingredientId, {
                amounts: [{ value: 1, unit: "cup" }],
              }),
            ],
          },
        ],
      }),
      actor,
    );

    // Soft-delete ONLY the recipe row, leaving its section + usage rows live.
    await getDb(db)
      .update(recipe)
      .set({ deletedAt: new Date() })
      .where(eq(recipe.id, created.id));

    expect(
      (await getIngredientByID(db, ingredientId)).appearsInRecipes,
    ).toHaveLength(0);

    const results = await globalSearch(db, "Orphan oregano");
    const hit = results.find(
      (r) => r.entityType === "ingredient" && r.id === ingredientId,
    );
    expect(hit && "recipeCount" in hit ? hit.recipeCount : undefined).toBe(0);
  });
});
