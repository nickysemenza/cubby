import type { RecipeId } from "@cubby/schemas/identifiers";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import { fromPartial } from "@total-typescript/shoehorn";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it } from "vitest";

import { setCfEnv } from "~/server/cf-env";
import { executeEntity } from "~/server/entity-kernel";
import { upsertCookbook } from "~/server/repo/cookbook";
import { findOrCreateIngredient } from "~/server/repo/ingredient";
import {
  findParentRecipesWithDeletedSubRecipes,
  type StaleParentRecipe,
} from "~/server/repo/problems";
import { createProduct } from "~/server/repo/product";
import {
  createRecipe,
  deleteRecipes,
  upsertCookbookRecipe,
} from "~/server/repo/recipe";
import { getRecipeTotalsState } from "~/server/repo/recipe/totals";
import { makeCookbookExtraction } from "~/server/repo/repo.fixtures";
import {
  ingredientRef,
  makeProductInput,
  makeRecipeInput,
} from "~/server/repo/repo.fixtures";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";
import { requireActor } from "~/server/request-context";
import { createTestRequestContext } from "~/server/testing/request-context";

import { deleteCookbookWorkflow } from "./recipe-import.server";

describe("recipe deletion cost-staleness workflows", () => {
  const ctx = withTestDb();
  const workflowContext = () =>
    requireActor(
      createTestRequestContext(ctx.db, {
        auth: { userId: ctx.actor.userId },
      }),
    );
  const recompute = (ids: RecipeId[]) =>
    workflowContext().services.recipeCosting.recompute(ids);
  const installFakeQueue = () =>
    setCfEnv(
      fromPartial<Env>({
        BACKGROUND_QUEUE: { send: async () => {}, sendBatch: async () => {} },
      }),
    );

  afterEach(() => setCfEnv(undefined));

  const seedParentWithSubRecipe = async () => {
    const ingredient = await findOrCreateIngredient(ctx.db, "sub flour");
    await createProduct(
      ctx.db,
      makeProductInput({
        name: "sub product",
        ingredientId: ingredient.id,
        price: 4,
      }),
      ctx.actor,
    );
    const child = await createRecipe(
      ctx.db,
      makeRecipeInput({
        name: "Sub Recipe B",
        sections: [
          {
            instructions: [{ instruction: "Mix" }],
            ingredients: [
              ingredientRef(ingredient.shortcode, {
                amounts: [{ value: 2, unit: "cup" }],
              }),
            ],
          },
        ],
      }),
      ctx.actor,
    );
    const parent = await createRecipe(
      ctx.db,
      makeRecipeInput({
        name: "Parent Recipe A",
        sections: [
          {
            instructions: [{ instruction: "Use B" }],
            ingredients: [
              {
                type: "recipe",
                recipeId: child.id,
                ingredientId: null,
                amounts: [{ value: 1, unit: "each" }],
              },
            ],
          },
        ],
      }),
      ctx.actor,
    );
    const [childEntityId, parentEntityId] = await Promise.all([
      resolveLiveShortcode(ctx.db, child.id, "recipe"),
      resolveLiveShortcode(ctx.db, parent.id, "recipe"),
    ]);
    if (!childEntityId || !parentEntityId) throw new Error("seed failed");
    return {
      child: parseEntityId("recipe", childEntityId),
      childCode: child.id,
      parent: parseEntityId("recipe", parentEntityId),
    };
  };

  it("marks the parent stale when its sub-recipe is deleted", async () => {
    const { child, childCode, parent } = await seedParentWithSubRecipe();
    await recompute([parent, child]);
    expect(
      (await getRecipeTotalsState(ctx.db, parent))?.totalsComputedAt,
    ).not.toBeNull();

    installFakeQueue();
    await executeEntity(workflowContext(), {
      action: "delete",
      entity: "recipe",
      ids: [childCode],
    });

    expect(
      (await getRecipeTotalsState(ctx.db, parent))?.totalsComputedAt,
    ).toBeNull();
    expect(await findParentRecipesWithDeletedSubRecipes(ctx.db)).toHaveLength(
      0,
    );
  });

  it("marks external parents stale when a cookbook deletes their sub-recipe", async () => {
    const bookName = "Doomed Book";
    const { output: cookbook, entityId: cookbookId } = await upsertCookbook(
      ctx.db,
      {
        name: bookName,
        rawJson: makeCookbookExtraction(),
        sourceLabel: bookName,
      },
      ctx.actor,
    );
    const ingredient = await findOrCreateIngredient(ctx.db, "book flour");
    const child = await upsertCookbookRecipe(
      makeRecipeInput({
        name: "Book Sub Recipe",
        sections: [
          {
            instructions: [{ instruction: "Mix" }],
            ingredients: [
              ingredientRef(ingredient.shortcode, {
                amounts: [{ value: 1, unit: "cup" }],
              }),
            ],
          },
        ],
      }),
      { id: cookbookId, name: bookName },
      ctx.db,
      ctx.actor,
    );
    const parent = await createRecipe(
      ctx.db,
      makeRecipeInput({
        name: "Non-Book Parent",
        sections: [
          {
            instructions: [{ instruction: "Use book sub" }],
            ingredients: [
              {
                type: "recipe",
                recipeId: parseShortcodeFor("recipe", child.shortcode),
                ingredientId: null,
                amounts: [{ value: 1, unit: "each" }],
              },
            ],
          },
        ],
      }),
      ctx.actor,
    );
    const parentEntityId = await resolveLiveShortcode(
      ctx.db,
      parent.id,
      "recipe",
    );
    if (!parentEntityId) throw new Error("seed failed");
    const resolvedParentId = parseEntityId("recipe", parentEntityId);
    await recompute([resolvedParentId, child.id]);
    expect(
      (await getRecipeTotalsState(ctx.db, resolvedParentId))?.totalsComputedAt,
    ).not.toBeNull();

    installFakeQueue();
    await deleteCookbookWorkflow(workflowContext(), {
      cookbookId: cookbook.id,
    });

    expect(
      (await getRecipeTotalsState(ctx.db, resolvedParentId))?.totalsComputedAt,
    ).toBeNull();
    expect(await findParentRecipesWithDeletedSubRecipes(ctx.db)).toHaveLength(
      0,
    );
  });

  const seedDetectorPair = async () => {
    const child = await createRecipe(
      ctx.db,
      makeRecipeInput({ name: "Detector Sub" }),
      ctx.actor,
    );
    const parent = await createRecipe(
      ctx.db,
      makeRecipeInput({
        name: "Detector Parent",
        sections: [
          {
            instructions: [{ instruction: "Use sub" }],
            ingredients: [
              {
                type: "recipe",
                recipeId: child.id,
                ingredientId: null,
                amounts: [{ value: 1, unit: "each" }],
              },
            ],
          },
        ],
      }),
      ctx.actor,
    );
    const [childId, parentId] = await Promise.all([
      resolveLiveShortcode(ctx.db, child.id, "recipe"),
      resolveLiveShortcode(ctx.db, parent.id, "recipe"),
    ]);
    if (!childId || !parentId) throw new Error("seed failed");
    return {
      child: parseEntityId("recipe", childId),
      parent: parseEntityId("recipe", parentId),
      parentCode: parent.id,
    };
  };

  it("detects a fresh parent left pointing at a deleted sub-recipe", async () => {
    const { child, parent, parentCode } = await seedDetectorPair();
    await recompute([parent]);
    await deleteRecipes(ctx.db, [child], ctx.actor);

    const flagged: StaleParentRecipe[] =
      await findParentRecipesWithDeletedSubRecipes(ctx.db);
    expect(flagged.map((recipe) => recipe.id)).toContain(parentCode);
  });
});
