import {
  type RecipeId,
  unsafeRecipeId,
  unsafeRecipeShortcode,
} from "@cubby/schemas/identifiers";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it } from "vitest";
import { createTestCaller, createTestTRPCContext } from "~/server/api/trpc";
import { setCfEnv } from "~/server/cf-env";
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
import {
  getRecipeTotalsState,
  getRecipeTotalsStateIncludingDeleted,
  markRecipesStale,
} from "~/server/repo/recipe/totals";
import {
  ingredientRef,
  makeProductInput,
  makeRecipeInput,
} from "~/server/repo/repo.fixtures";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";
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
              ingredientRef(ing.shortcode, {
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
      child: unsafeRecipeId(childEntityId),
      childCode: child.id,
      parent: unsafeRecipeId(parentEntityId),
    };
  };

  const recompute = (ids: RecipeId[]) =>
    createTestTRPCContext(ctx.db, {
      auth: { userId: ctx.actor.userId },
    }).services.recipeCosting.recompute(ids);

  it("marks the parent stale when its sub-recipe is deleted", async () => {
    const { child, childCode, parent } = await seedParentWithSubRecipe();

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
    await caller.delete({ ids: [childCode] });

    expect(
      (await getRecipeTotalsState(ctx.db, parent))?.totalsComputedAt,
    ).toBeNull();
    // Guardrail detector agrees: no fresh parent left pointing at a deleted sub.
    expect(await findParentRecipesWithDeletedSubRecipes(ctx.db)).toHaveLength(
      0,
    );
  });

  // deleteCookbook is a SECOND recipe-delete path (import router) — it must
  // carry the same parent-staleness propagation as crud.ts's deleteItem, for a
  // parent in a DIFFERENT (or no) cookbook that uses a deleted book recipe as a
  // sub-recipe.
  it("marks the parent stale when its sub-recipe is deleted via deleteCookbook", async () => {
    const bookName = "Doomed Book";
    const { output: cookbook, entityId: cookbookId } = await upsertCookbook(
      ctx.db,
      { name: bookName, rawJson: [], sourceLabel: bookName },
      ctx.actor,
    );

    const ing = await findOrCreateIngredient(ctx.db, "book flour");
    const child = await upsertCookbookRecipe(
      makeRecipeInput({
        name: "Book Sub Recipe",
        sections: [
          {
            instructions: [{ instruction: "Mix" }],
            ingredients: [
              ingredientRef(ing.shortcode, {
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
                recipeId: unsafeRecipeShortcode(child.shortcode),
                ingredientId: null,
                amounts: [{ value: 1, unit: "each" }],
              },
            ],
          },
        ],
      }),
      ctx.actor,
    );

    const parentEntityId = resolveLiveShortcode(ctx.db, parent.id, "recipe");
    const resolvedParentId = unsafeRecipeId((await parentEntityId)!);
    await recompute([resolvedParentId, child.id]);
    expect(
      (await getRecipeTotalsState(ctx.db, resolvedParentId))?.totalsComputedAt,
    ).not.toBeNull();

    installFakeQueue();
    const caller = createTestCaller(recipeRouter, ctx.db);
    await caller.deleteCookbook({ cookbookId: cookbook.id });

    expect(
      (await getRecipeTotalsState(ctx.db, resolvedParentId))?.totalsComputedAt,
    ).toBeNull();
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
    const [childEntityId, parentEntityId] = await Promise.all([
      resolveLiveShortcode(ctx.db, child.id, "recipe"),
      resolveLiveShortcode(ctx.db, parent.id, "recipe"),
    ]);
    if (!childEntityId || !parentEntityId) throw new Error("seed failed");
    return {
      child: unsafeRecipeId(childEntityId),
      parent: unsafeRecipeId(parentEntityId),
      parentCode: parent.id,
    };
  };

  const recompute = (ids: RecipeId[]) =>
    createTestTRPCContext(ctx.db, {
      auth: { userId: ctx.actor.userId },
    }).services.recipeCosting.recompute(ids);

  it("flags a fresh parent whose sub-recipe was soft-deleted without propagation", async () => {
    const { child, parent, parentCode } = await seed();
    // Stamp the parent fresh, then soft-delete the child at the repo layer (no
    // staleness propagation) to reconstruct the escaped state directly.
    await recompute([parent]);
    await deleteRecipes(ctx.db, [child], ctx.actor);

    const flagged: StaleParentRecipe[] =
      await findParentRecipesWithDeletedSubRecipes(ctx.db);
    expect(flagged.map((r) => r.id)).toContain(parentCode);
  });

  it("does not flag a parent whose sub-recipe is still live", async () => {
    const { parent, parentCode } = await seed();
    await recompute([parent]);

    const flagged = await findParentRecipesWithDeletedSubRecipes(ctx.db);
    expect(flagged.map((r) => r.id)).not.toContain(parentCode);
  });
});

// Regression guard: `findParentRecipeIdsBatch` deliberately does not filter
// `deletedAt` on its joins, so a cascade can hand `markRecipesStale` the id of
// a recipe that was soft-deleted between dispatch and write. Nothing later
// heals that stamp (selectStaleRecipeIds/selectAllStaleRecipeIds/
// countStaleRecipeTotals/getRecipesByIDs all require notDeleted), so a stamp
// that reaches a deleted row would be permanent and invisible to Settings →
// Maintenance. `markRecipesStale` must exclude deleted recipes itself.
describe("markRecipesStale liveness guard", () => {
  const ctx = withTestDb();

  const recompute = (ids: RecipeId[]) =>
    createTestTRPCContext(ctx.db, {
      auth: { userId: ctx.actor.userId },
    }).services.recipeCosting.recompute(ids);

  it("does not null totalsComputedAt for a soft-deleted recipe", async () => {
    const created = await createRecipe(
      ctx.db,
      makeRecipeInput({ name: "Soon Deleted" }),
      ctx.actor,
    );
    const entityId = await resolveLiveShortcode(ctx.db, created.id, "recipe");
    if (!entityId) throw new Error("seed failed");
    const target = unsafeRecipeId(entityId);

    await recompute([target]);
    expect(
      (await getRecipeTotalsState(ctx.db, target))?.totalsComputedAt,
    ).not.toBeNull();

    // Repo layer directly, bypassing the router — reconstructs the escaped
    // state (a recipe deleted out from under a dispatch already in flight).
    await deleteRecipes(ctx.db, [target], ctx.actor);

    // Simulates a cascade reaching the now-deleted id (e.g. via
    // findParentRecipeIdsBatch's deliberately inclusive join).
    await markRecipesStale(ctx.db, [target]);

    // getRecipeTotalsState itself filters notDeleted, so it can't tell us
    // whether the stamp was (wrongly) cleared on a deleted row.
    const row = await getRecipeTotalsStateIncludingDeleted(ctx.db, target);
    expect(row?.totalsComputedAt).not.toBeNull();
  });
});
