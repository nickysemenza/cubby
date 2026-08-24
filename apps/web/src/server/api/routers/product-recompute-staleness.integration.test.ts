import {
  type IngredientId,
  type ProductShortcode,
  type RecipeId,
  unsafeRecipeId,
} from "@cubby/schemas/identifiers";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it } from "vitest";
import { createTestCaller, createTestTRPCContext } from "~/server/api/trpc";
import { setCfEnv } from "~/server/cf-env";
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
import { productRouter } from "./product";

/**
 * A product feeds recipe cost through its linked ingredient (price + the
 * `productUnitMappings` costing converts with). Product create/update/applyUpc/
 * createMany all dispatch a recompute; `delete` and `merge` did not, even though
 * both change those inputs — delete soft-deletes the unit mappings, and merge
 * carries `price`/`ingredientId` and re-points `ProductUnitMappings.productId`.
 *
 * `runMutationSideEffectsForEntities` does not cover the gap:
 * `needsValuationRecompute` fires only for product + `updated`, and only for the
 * LOCATION valuation rollup. There is no cron recompute either — the only full
 * pass is the manual maintenance card — so a stale `Recipe.totals` persisted
 * indefinitely, showing a cost derived from a product that is gone.
 */
describe("product delete/merge propagate cost staleness to recipes", () => {
  const ctx = withTestDb();

  const installFakeQueue = () => {
    setCfEnv({
      BACKGROUND_QUEUE: {
        send: async () => {},
        sendBatch: async () => {},
      },
    } as unknown as Env);
  };
  afterEach(() => setCfEnv(undefined as unknown as Env));

  const seedProduct = async (
    name: string,
    ingredientId: IngredientId,
    price: number,
  ): Promise<ProductShortcode> => {
    const created = await createProduct(
      ctx.db,
      makeProductInput({ name, manufacturer: name, ingredientId, price }),
      ctx.actor,
    );
    return created.id;
  };

  /** A recipe costed from `ingredientShortcode`, returned as its internal id. */
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
    return unsafeRecipeId(entityId);
  };

  const recompute = (ids: RecipeId[]) =>
    createTestTRPCContext(ctx.db, {
      auth: { userId: ctx.actor.userId },
    }).services.recipeCosting.recompute(ids);

  const totalsComputedAt = async (id: RecipeId) =>
    (await getRecipeTotalsState(ctx.db, id))?.totalsComputedAt;

  it("marks a recipe stale when a product feeding its ingredient is deleted", async () => {
    const ing = await findOrCreateIngredient(ctx.db, "delete flour");
    const productCode = await seedProduct("Delete Flour Co", ing.id, 6);
    const recipe = await seedRecipe("Delete Flour Recipe", ing.shortcode);

    await recompute([recipe]);
    expect(await totalsComputedAt(recipe)).not.toBeNull();

    installFakeQueue();
    const caller = createTestCaller(productRouter, ctx.db);
    await caller.delete({ ids: [productCode] });

    expect(await totalsComputedAt(recipe)).toBeNull();
  });

  // The merge case that proves the ingredient links must be read BEFORE the
  // merge: the recipe hangs off the LOSER's ingredient, and the keeper already
  // has an ingredient of its own — so `CARRIED_COLUMNS` does not carry the
  // loser's `ingredientId`, and the loser row is soft-deleted (unreadable) by
  // the time the merge returns. Reading the keeper's post-merge link alone would
  // miss this recipe entirely.
  it("marks a recipe stale when a product feeding its ingredient is merged away", async () => {
    const keeperIng = await findOrCreateIngredient(ctx.db, "merge sugar");
    const loserIng = await findOrCreateIngredient(ctx.db, "merge flour");
    const keeper = await seedProduct("Merge Sugar Co", keeperIng.id, 5);
    const loser = await seedProduct("Merge Flour Co", loserIng.id, 4);
    const recipe = await seedRecipe("Merge Flour Recipe", loserIng.shortcode);

    await recompute([recipe]);
    expect(await totalsComputedAt(recipe)).not.toBeNull();

    installFakeQueue();
    const caller = createTestCaller(productRouter, ctx.db);
    await caller.merge({ keepId: keeper, mergeIds: [loser] });

    expect(await totalsComputedAt(recipe)).toBeNull();
  });
});
