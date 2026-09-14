/**
 * `Recipe.forkedFromRecipeId` — a nullable self-FK lineage pointer (no "fork"
 * action; the pointer is a plain field settable via create/update). Covers the
 * create/update round trip, the self-reference guard, and the delete
 * disposition (`RECIPE_DELETE_EDGE_POLICY["Recipe.forkedFromRecipeId"]`,
 * effect "detach" — deleting the recipe a fork points at clears the pointer
 * rather than cascading to the fork itself).
 */
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  createRecipeFixture as createRecipeFx,
  makeRecipeInput,
} from "../repo.fixtures";
import { deleteRecipes, getRecipeByShortcode, updateRecipe } from "./crud";

describe("Recipe.forkedFromRecipeId", () => {
  const ctx = withTestDb();

  it("is set on create and updated/cleared on update", async () => {
    const parent = await createRecipeFx(
      ctx.db,
      makeRecipeInput({ name: "Original Loaf" }),
      ctx.actor,
    );
    const otherParent = await createRecipeFx(
      ctx.db,
      makeRecipeInput({ name: "Other Loaf" }),
      ctx.actor,
    );

    // Create with the pointer set.
    const child = await createRecipeFx(
      ctx.db,
      {
        ...makeRecipeInput({ name: "Loaf Riff" }),
        forkedFromRecipeId: parent.id,
      },
      ctx.actor,
    );
    expect(child.forkedFromRecipeId).toBe(parent.id);
    expect(child.forkedFromRecipeName).toBe("Original Loaf");

    // Update to point at a different recipe.
    const repointed = await updateRecipe(
      ctx.db,
      child.entityId,
      { forkedFromRecipeId: otherParent.id },
      ctx.actor,
    );
    expect(repointed.recipe.forkedFromRecipeId).toBe(otherParent.id);
    expect(repointed.recipe.forkedFromRecipeName).toBe("Other Loaf");

    // Update to clear the pointer.
    const cleared = await updateRecipe(
      ctx.db,
      child.entityId,
      { forkedFromRecipeId: null },
      ctx.actor,
    );
    expect(cleared.recipe.forkedFromRecipeId).toBeNull();
    expect(cleared.recipe.forkedFromRecipeName).toBeNull();
  });

  it("refuses a recipe forking from itself", async () => {
    const recipe = await createRecipeFx(
      ctx.db,
      makeRecipeInput({ name: "Self Referential Bread" }),
      ctx.actor,
    );

    await expect(
      updateRecipe(
        ctx.db,
        recipe.entityId,
        { forkedFromRecipeId: recipe.id },
        ctx.actor,
      ),
    ).rejects.toMatchObject({ reason: "SELF_DEPENDENCY" });
  });

  it("nulls the child's pointer when the recipe it was forked from is deleted", async () => {
    const parent = await createRecipeFx(
      ctx.db,
      makeRecipeInput({ name: "Doomed Original" }),
      ctx.actor,
    );
    const child = await createRecipeFx(
      ctx.db,
      {
        ...makeRecipeInput({ name: "Surviving Fork" }),
        forkedFromRecipeId: parent.id,
      },
      ctx.actor,
    );
    expect(child.forkedFromRecipeId).toBe(parent.id);

    await deleteRecipes(ctx.db, [parent.entityId], ctx.actor);

    const afterDelete = await getRecipeByShortcode(ctx.db, child.id);
    expect(afterDelete).not.toBeNull();
    expect(afterDelete?.forkedFromRecipeId).toBeNull();
    expect(afterDelete?.forkedFromRecipeName).toBeNull();
  });
});
