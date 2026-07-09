import type { RecipeId } from "@cubby/schemas/identifiers";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it } from "vitest";
import { createTestCaller, createTestTRPCContext } from "~/server/api/trpc";
import { setCfEnv } from "~/server/cf-env";
import { findOrCreateIngredient } from "~/server/repo/ingredient";
import {
  findParentRecipesWithDeletedSubRecipes,
  type StaleParentRecipe,
} from "~/server/repo/problems";
import { createProduct } from "~/server/repo/product";
import { createRecipe, deleteRecipes } from "~/server/repo/recipe";
import { getRecipeTotalsState } from "~/server/repo/recipe/totals";
import {
  ingredientRef,
  makeProductInput,
  makeRecipeInput,
} from "~/server/repo/repo.fixtures";
import { recipeRouter } from "../recipe";

// F2 regression guard: a parent recipe (A) that includes a sub-recipe (B) bakes
// B's cost into A's persisted totals. Deleting B must propagate cost staleness to
// A — the recipe manifest has onDelete: [] and needsValuationRecompute is false
// for recipe, so nothing else marks A stale. Before the fix, A stayed "fresh"
// with B's cost silently baked in and countStaleRecipeTotals missed it.
describe("recipe delete propagates cost staleness to parents", () => {
  const ctx = withTestDb();

  // Install a fake BACKGROUND_QUEUE so dispatchRecompute marks the parent stale
  // and QUEUES it (rather than draining inline and re-stamping it fresh) — this
  // isolates "did delete propagate staleness" from drain timing.
  const installFakeQueue = () => {
    setCfEnv({
      BACKGROUND_QUEUE: {
        send: async () => {},
        sendBatch: async () => {},
      },
    } as unknown as Env);
  };
  afterEach(() => setCfEnv(undefined as unknown as Env));

  // Priced sub-recipe B + parent A that includes B as a recipe-ingredient.
  const seedParentWithSubRecipe = async () => {
    const ing = await findOrCreateIngredient(ctx.db, "sub flour");
    await createProduct(
      ctx.db,
      makeProductInput({ name: "sub product", ingredientId: ing.id, price: 4 }),
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
              ingredientRef(ing.id, { amounts: [{ value: 2, unit: "cup" }] }),
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
    return { child: child.id as RecipeId, parent: parent.id as RecipeId };
  };

  const recompute = (ids: RecipeId[]) =>
    createTestTRPCContext(ctx.db, {
      auth: { userId: ctx.actor.userId },
    }).services.recipeCosting.recompute(ids);

  it("marks the parent stale when its sub-recipe is deleted", async () => {
    const { child, parent } = await seedParentWithSubRecipe();

    // Stamp both fresh (inline, no queue bound yet).
    await recompute([parent, child]);
    expect(
      (await getRecipeTotalsState(ctx.db, parent))?.totalsComputedAt,
    ).not.toBeNull();

    // Delete the sub-recipe through the router (the F2 fix lives in the delete
    // procedure). With the fake queue bound, the propagated recompute only marks
    // the parent stale — totalsComputedAt returns to null.
    installFakeQueue();
    const caller = createTestCaller(recipeRouter, ctx.db);
    await caller.delete({ ids: [child] });

    expect(
      (await getRecipeTotalsState(ctx.db, parent))?.totalsComputedAt,
    ).toBeNull();
    // Guardrail detector agrees: no fresh parent left pointing at a deleted sub.
    expect(await findParentRecipesWithDeletedSubRecipes(ctx.db)).toHaveLength(
      0,
    );
  });
});

// Guardrail for the escaped state the F2 bug would leave: a live parent marked
// fresh that still references a soft-deleted sub-recipe (countStaleRecipeTotals
// can't see it because totalsComputedAt is non-null).
describe("findParentRecipesWithDeletedSubRecipes detector", () => {
  const ctx = withTestDb();

  const seed = async () => {
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
    return { child: child.id as RecipeId, parent: parent.id as RecipeId };
  };

  const recompute = (ids: RecipeId[]) =>
    createTestTRPCContext(ctx.db, {
      auth: { userId: ctx.actor.userId },
    }).services.recipeCosting.recompute(ids);

  it("flags a fresh parent whose sub-recipe was soft-deleted without propagation", async () => {
    const { child, parent } = await seed();
    // Stamp the parent fresh, then soft-delete the child at the repo layer (no
    // staleness propagation) to reconstruct the escaped state directly.
    await recompute([parent]);
    await deleteRecipes(ctx.db, [child], ctx.actor);

    const flagged: StaleParentRecipe[] =
      await findParentRecipesWithDeletedSubRecipes(ctx.db);
    expect(flagged.map((r) => r.id)).toContain(parent);
  });

  it("does not flag a parent whose sub-recipe is still live", async () => {
    const { parent } = await seed();
    await recompute([parent]);

    const flagged = await findParentRecipesWithDeletedSubRecipes(ctx.db);
    expect(flagged.map((r) => r.id)).not.toContain(parent);
  });
});
