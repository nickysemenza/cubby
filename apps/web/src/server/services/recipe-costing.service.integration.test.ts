import type { RecipeId } from "@cubby/schemas/identifiers";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { setCfEnv } from "~/server/cf-env";
import { RECOMPUTE_CHUNK_SIZE } from "~/server/queue-recompute";
import {
  getBackgroundBatchDetail,
  listBackgroundBatches,
} from "~/server/repo/background-jobs";
import { updateProduct } from "~/server/repo/product";
import { getRecipesByIDs, updateRecipe } from "~/server/repo/recipe";
import { getRecipeTotalsState } from "~/server/repo/recipe/totals";
import { createTestTRPCContext } from "../api/trpc";
import { findOrCreateIngredient } from "../repo/ingredient";
import {
  createProductFixture as createProduct,
  createRecipeFixture as createRecipe,
  ingredientRef,
  makeProductInput,
  makeRecipeInput,
} from "../repo/repo.fixtures";

// Exercises RecipeCostingService end-to-end against a real DB (IntegresQL). The
// costing WASM is pure; the test context stubs the USDA client to 404 every
// lookup → `food: null`. USDA is always-available in prod now, so a null is a
// genuine "food not found" — a *permanent* gap (an unresolvable fdc_id), not a
// transient miss to retry. computeTotals still flags it `complete: false` via
// `usdaMissesFor`, but recompute stamps such a recipe fresh (the gap is real).

// An arbitrary FoodData Central id the stub USDA backend 404s → `food: null` (a
// permanent not-found, i.e. an ingredient with an unresolvable USDA link).
const UNRESOLVABLE_FDC_ID = 999_999;

describe("RecipeCostingService", () => {
  const ctx = withTestDb();

  const service = () =>
    createTestTRPCContext(ctx.db, { auth: { userId: ctx.actor.userId } })
      .services.recipeCosting;

  // A recipe whose single ingredient is linked to a priced product. Price-only
  // (no fdc_id) means no USDA lookup, so it costs "complete".
  const seedPricedRecipe = async (name: string) => {
    const ing = await findOrCreateIngredient(ctx.db, `${name} flour`);
    await createProduct(
      ctx.db,
      makeProductInput({
        name: `${name} product`,
        ingredientId: ing.id,
        price: 4,
      }),
      ctx.actor,
    );
    return createRecipe(
      ctx.db,
      makeRecipeInput({
        name,
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
  };

  describe("computeTotals", () => {
    it("marks a fully-mapped recipe complete with totals present", async () => {
      const recipe = await seedPricedRecipe("Complete Recipe");
      const result = await service().computeTotals([recipe]);

      const entry = result.get(recipe.id);
      expect(entry).toBeDefined();
      expect(entry?.complete).toBe(true);
      expect(entry?.totals.ingredientCount).toBe(1);
    });

    it("marks a recipe with an unresolved USDA link incomplete", async () => {
      const ing = await findOrCreateIngredient(ctx.db, "usda flour");
      // fdc_id set but the stub USDA backend 404s → `food: null` (a permanent
      // not-found), which `usdaMissesFor` still flags → complete: false.
      await createProduct(
        ctx.db,
        makeProductInput({
          name: "usda product",
          ingredientId: ing.id,
          fdc_id: UNRESOLVABLE_FDC_ID,
        }),
        ctx.actor,
      );
      const recipe = await createRecipe(
        ctx.db,
        makeRecipeInput({
          name: "Incomplete Recipe",
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
        ctx.actor,
      );

      const entry = (await service().computeTotals([recipe])).get(recipe.id);
      expect(entry?.complete).toBe(false);
    });
  });

  describe("loadContext closure (via computeTotals)", () => {
    // Build A → B → C (recipe-as-ingredient links) and confirm the whole closure
    // is loaded (totals computed without error). A real bug here would surface as
    // a missing sub-recipe rather than a thrown error, so we also assert presence.
    it("loads a transitive sub-recipe closure", async () => {
      const c = await seedPricedRecipe("Leaf C");
      const b = await createRecipe(
        ctx.db,
        makeRecipeInput({
          name: "Mid B",
          sections: [
            {
              instructions: [{ instruction: "Use C" }],
              ingredients: [
                {
                  type: "recipe",
                  recipeId: c.id,
                  ingredientId: null,
                  amounts: [{ value: 1, unit: "each" }],
                },
              ],
            },
          ],
        }),
        ctx.actor,
      );
      const a = await createRecipe(
        ctx.db,
        makeRecipeInput({
          name: "Top A",
          sections: [
            {
              instructions: [{ instruction: "Use B" }],
              ingredients: [
                {
                  type: "recipe",
                  recipeId: b.id,
                  ingredientId: null,
                  amounts: [{ value: 1, unit: "each" }],
                },
              ],
            },
          ],
        }),
        ctx.actor,
      );

      const result = await service().computeTotals([a]);
      expect(result.get(a.id)).toBeDefined();
    });

    it("terminates on a cyclic sub-recipe reference", async () => {
      // A links B; then B links A — a cycle. loadContext's `seen` set must break it.
      const a = await seedPricedRecipe("Cycle A");
      const b = await createRecipe(
        ctx.db,
        makeRecipeInput({
          name: "Cycle B",
          sections: [
            {
              instructions: [{ instruction: "Use A" }],
              ingredients: [
                {
                  type: "recipe",
                  recipeId: a.id,
                  ingredientId: null,
                  amounts: [{ value: 1, unit: "each" }],
                },
              ],
            },
          ],
        }),
        ctx.actor,
      );
      await updateRecipe(
        ctx.db,
        a.entityId,
        {
          sections: [
            {
              instructions: [{ instruction: "Use B" }],
              ingredients: [
                {
                  type: "recipe",
                  recipeId: b.id,
                  ingredientId: null,
                  amounts: [{ value: 1, unit: "each" }],
                },
              ],
            },
          ],
        },
        ctx.actor,
      );

      const [reloadedA] = await getRecipesByIDs(ctx.db, [a.entityId]);
      // Should resolve (not hang); the result map contains A.
      const result = await service().computeTotals([reloadedA!]);
      expect(result.get(a.id)).toBeDefined();
    });
  });

  describe("recompute", () => {
    it("persists totals and stamps a complete recipe fresh", async () => {
      const recipe = await seedPricedRecipe("Persist Recipe");
      await service().recompute([recipe.entityId]);

      const state = await getRecipeTotalsState(ctx.db, recipe.entityId);
      expect(state?.totals).not.toBeNull();
      expect(state?.totalsComputedAt).not.toBeNull();
    });

    it("stamps a recipe with an unresolvable USDA link fresh (gap, not stale)", async () => {
      const ing = await findOrCreateIngredient(ctx.db, "stale flour");
      await createProduct(
        ctx.db,
        makeProductInput({
          name: "stale product",
          ingredientId: ing.id,
          fdc_id: UNRESOLVABLE_FDC_ID,
        }),
        ctx.actor,
      );
      const recipe = await createRecipe(
        ctx.db,
        makeRecipeInput({
          name: "Gap Recipe",
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
        ctx.actor,
      );

      await service().recompute([recipe.entityId]);
      const state = await getRecipeTotalsState(ctx.db, recipe.entityId);
      expect(state?.totals).not.toBeNull();
      // USDA is reliable now, so an unresolved fdc_id is a permanent costing gap
      // (surfaced by the coverage UI), not a stale-for-retry row — stamp fresh.
      expect(state?.totalsComputedAt).not.toBeNull();
    });

    it("eagerly recomputes a parent when a child's cost changes", async () => {
      // A *costable* child: 1 lb of an ingredient priced "1 lb = $4" → $4 (a
      // weight→money package mapping, the form the engine can actually convert).
      const ing = await findOrCreateIngredient(ctx.db, "cascade flour");
      const priceMapping = (dollars: number) => ({
        a: { value: 1, unit: "lb" },
        b: { value: dollars, unit: "dollar" },
        source: "test",
      });
      const prod = await createProduct(
        ctx.db,
        makeProductInput({
          name: "cascade product",
          ingredientId: ing.id,
          unitMappings: [priceMapping(4)],
        }),
        ctx.actor,
      );
      const child = await createRecipe(
        ctx.db,
        makeRecipeInput({
          name: "Cascade Child",
          sections: [
            {
              instructions: [{ instruction: "Mix" }],
              ingredients: [
                ingredientRef(ing.shortcode, {
                  amounts: [{ value: 1, unit: "lb" }],
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
          name: "Cascade Parent",
          sections: [
            {
              instructions: [{ instruction: "Use child" }],
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

      // Compute both; the child costs $4 and the parent is stamped fresh.
      await service().recompute([parent.entityId, child.entityId]);
      const childBefore = await getRecipeTotalsState(ctx.db, child.entityId);
      const parentBefore = await getRecipeTotalsState(ctx.db, parent.entityId);
      expect(childBefore?.totals?.costTotal).toBe(4);
      expect(parentBefore?.totalsComputedAt).not.toBeNull();

      // Change the child's cost, then recompute ONLY the child. Because the
      // child's totals changed, the eager cascade recomputes its parent too — no
      // drain — re-stamping the parent's totals with a fresh (later) timestamp.
      await updateProduct(
        ctx.db,
        prod.entityId,
        { unitMappings: [priceMapping(10)] },
        ctx.actor,
      );
      await service().recompute([child.entityId]);

      const childAfter = await getRecipeTotalsState(ctx.db, child.entityId);
      const parentAfter = await getRecipeTotalsState(ctx.db, parent.entityId);
      expect(childAfter?.totals?.costTotal).toBe(10);
      expect(parentAfter?.totalsComputedAt?.getTime() ?? 0).toBeGreaterThan(
        parentBefore?.totalsComputedAt?.getTime() ?? 0,
      );
    });
  });

  describe("dispatchRecompute", () => {
    // Install a fake BACKGROUND_QUEUE binding (the repo has no real one in tests).
    // Returns captured wakeup messages + a reset to clear the module-level cfEnv
    // so the queue doesn't leak into tests expecting inline/no-binding behavior.
    const installFakeQueue = () => {
      const sent: Array<{ batchId: string; jobId: string }> = [];
      setCfEnv({
        BACKGROUND_QUEUE: {
          send: async (m: { batchId: string; jobId: string }) => {
            sent.push({ batchId: m.batchId, jobId: m.jobId });
          },
          sendBatch: async (
            messages: Iterable<{
              body: { batchId: string; jobId: string };
            }>,
          ) => {
            for (const { body } of messages) {
              sent.push({ batchId: body.batchId, jobId: body.jobId });
            }
          },
        },
      } as unknown as Env);
      return { sent, reset: () => setCfEnv(undefined as unknown as Env) };
    };

    it("persists and processes jobs inline when no queue is bound", async () => {
      const ids: RecipeId[] = [];
      for (let i = 0; i < 3; i++) {
        ids.push((await seedPricedRecipe(`Inline ${i}`)).entityId);
      }
      const returnedBatches = await service().dispatchRecompute(ids);
      expect(returnedBatches).toHaveLength(1);
      const [batch] = await listBackgroundBatches(ctx.db, 1);
      expect(returnedBatches[0]?.id).toBe(batch?.id);
      expect(batch?.kind).toBe("recipe-totals.recompute");
      expect(batch?.processor).toBe("inline");
      expect(batch?.status).toBe("succeeded");
      expect(batch?.totalJobs).toBe(1);
      for (const id of ids) {
        const state = await getRecipeTotalsState(ctx.db, id);
        expect(state?.totalsComputedAt).not.toBeNull();
      }
    });

    it("queues persisted jobs when a queue is bound", async () => {
      const { sent, reset } = installFakeQueue();
      try {
        const ids: RecipeId[] = [];
        for (let i = 0; i < 3; i++) {
          ids.push((await seedPricedRecipe(`Queued ${i}`)).entityId);
        }
        const returnedBatches = await service().dispatchRecompute(ids);
        expect(returnedBatches).toHaveLength(1);
        expect(sent).toHaveLength(1);
        expect(returnedBatches[0]?.id).toBe(sent[0]!.batchId);
        const batch = await getBackgroundBatchDetail(ctx.db, sent[0]!.batchId);
        expect(batch?.processor).toBe("queue");
        expect(batch?.jobs).toHaveLength(1);
        expect(batch?.jobs[0]?.payload).toEqual({ recipeIds: ids });
        // Every id was persisted in a job and rows were marked stale, not
        // recomputed on the request path.
        for (const id of ids) {
          const state = await getRecipeTotalsState(ctx.db, id);
          expect(state?.totalsComputedAt).toBeNull();
        }
      } finally {
        reset();
      }
    });

    it("chunks large recompute sets", async () => {
      const { sent, reset } = installFakeQueue();
      try {
        const ids: RecipeId[] = [];
        for (let i = 0; i <= RECOMPUTE_CHUNK_SIZE; i++) {
          ids.push((await seedPricedRecipe(`Queued chunk ${i}`)).entityId);
        }
        const returnedBatches = await service().dispatchRecompute(ids);
        expect(returnedBatches).toHaveLength(1);
        expect(sent).toHaveLength(2);
        const batch = await getBackgroundBatchDetail(ctx.db, sent[0]!.batchId);
        expect(batch?.processor).toBe("queue");
        expect(batch?.jobs).toHaveLength(2);
      } finally {
        reset();
      }
    });
  });
});
