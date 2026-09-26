import type {
  IngredientId,
  ProductShortcode,
  RecipeId,
} from "@cubby/schemas/identifiers";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { fromPartial } from "@total-typescript/shoehorn";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it } from "vitest";

import { setCfEnv } from "~/server/cf-env";
import { executeEntity } from "~/server/entity-kernel";
import { findOrCreateIngredient } from "~/server/repo/ingredient";
import { createProduct } from "~/server/repo/product";
import { createRecipe } from "~/server/repo/recipe";
import { getRecipeTotalsState } from "~/server/repo/recipe/totals";
import {
  ingredientRef,
  makeProductInput,
  makeRecipeInput,
} from "~/server/repo/repo.fixtures";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";
import { requireActor } from "~/server/request-context";
import { createTestRequestContext } from "~/server/testing/request-context";

describe("product mutation recipe-cost staleness", () => {
  const ctx = withTestDb();
  const workflowContext = () =>
    requireActor(
      createTestRequestContext(ctx.db, {
        auth: { userId: ctx.actor.userId },
      }),
    );

  afterEach(() => setCfEnv(undefined));

  const installFakeQueue = () =>
    setCfEnv(
      fromPartial<Env>({
        BACKGROUND_QUEUE: { send: async () => {}, sendBatch: async () => {} },
      }),
    );

  const seedProduct = async (
    name: string,
    ingredientId: IngredientId,
    price: number,
  ): Promise<ProductShortcode> =>
    (
      await createProduct(
        ctx.db,
        makeProductInput({ name, manufacturer: name, ingredientId, price }),
        ctx.actor,
      )
    ).id;

  const seedRecipe = async (
    name: string,
    ingredientShortcode: string,
  ): Promise<RecipeId> => {
    const recipe = await createRecipe(
      ctx.db,
      makeRecipeInput({
        name,
        sections: [
          {
            instructions: [{ instruction: "Mix" }],
            ingredients: [
              ingredientRef(ingredientShortcode, {
                amounts: [{ value: 2, unit: "cup" }],
              }),
            ],
          },
        ],
      }),
      ctx.actor,
    );
    const entityId = await resolveLiveShortcode(ctx.db, recipe.id, "recipe");
    if (!entityId) throw new Error("seed failed: recipe did not resolve");
    return parseEntityId("recipe", entityId);
  };

  const totalsComputedAt = async (id: RecipeId) =>
    (await getRecipeTotalsState(ctx.db, id))?.totalsComputedAt;

  it("marks a recipe stale when its priced product is deleted", async () => {
    const ingredient = await findOrCreateIngredient(ctx.db, "delete flour");
    const product = await seedProduct("Delete Flour Co", ingredient.id, 6);
    const recipe = await seedRecipe(
      "Delete Flour Recipe",
      ingredient.shortcode,
    );
    const context = workflowContext();

    await context.services.recipeCosting.recompute([recipe]);
    expect(await totalsComputedAt(recipe)).not.toBeNull();

    installFakeQueue();
    await executeEntity(context, {
      action: "delete",
      entity: "product",
      ids: [product],
    });
    expect(await totalsComputedAt(recipe)).toBeNull();
  });

  it("marks recipes linked to the merge loser stale before it disappears", async () => {
    const keeperIngredient = await findOrCreateIngredient(
      ctx.db,
      "merge sugar",
    );
    const loserIngredient = await findOrCreateIngredient(ctx.db, "merge flour");
    const keeper = await seedProduct("Merge Sugar Co", keeperIngredient.id, 5);
    const loser = await seedProduct("Merge Flour Co", loserIngredient.id, 4);
    const recipe = await seedRecipe(
      "Merge Flour Recipe",
      loserIngredient.shortcode,
    );
    const context = workflowContext();

    await context.services.recipeCosting.recompute([recipe]);
    expect(await totalsComputedAt(recipe)).not.toBeNull();

    installFakeQueue();
    await executeEntity(context, {
      action: "merge",
      entity: "product",
      data: { keepId: keeper, mergeIds: [loser] },
    });
    expect(await totalsComputedAt(recipe)).toBeNull();
  });
});
