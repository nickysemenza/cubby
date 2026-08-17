import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { createTestCaller } from "~/server/api/trpc";
import { createRecipe } from "~/server/repo/recipe";
import { makeRecipeInput } from "~/server/repo/repo.fixtures";
import { recipeRouter } from "../recipe";

describe("recipe flow public IDs", () => {
  const ctx = withTestDb();

  it("accepts a recipe shortcode end to end", async () => {
    const recipe = await createRecipe(
      ctx.db,
      makeRecipeInput({ name: "Flow shortcode recipe" }),
      ctx.actor,
    );
    const caller = createTestCaller(recipeRouter, ctx.db);

    await expect(caller.getFlow({ id: recipe.id })).resolves.toMatchObject({
      status: "missing",
    });
  });
});
