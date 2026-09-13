import { buildNutrition, type NutritionTotals } from "@cubby/schemas/nutrition";
import { recipeTotals } from "@cubby/schemas/recipe-shared";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { updateProduct } from "~/server/repo/product";
import { getRecipesByIDs } from "~/server/repo/recipe/crud";
import { recipeList } from "~/server/repo/recipe/crud";
import {
  getRecipeTotalsState,
  selectAllStaleRecipeIds,
} from "~/server/repo/recipe/totals";
import {
  recomputeAllDurableWorkflow,
  recomputeStaleDurableWorkflow,
} from "~/server/workflows/recipe.server";

import { findOrCreateIngredient } from "../repo/ingredient";
import {
  createProductFixture as createProduct,
  createRecipeFixture as createRecipe,
  ingredientRef,
  makeProductInput,
  makeRecipeInput,
  setRecipeTotalsFixtureRaw,
} from "../repo/repo.fixtures";
import { createTestRequestContext } from "../testing/request-context";

// Exercises RecipeCostingService end-to-end against a real DB (IntegresQL). The
// costing WASM is pure; the test context stubs the USDA client to 404 every
// lookup → `food: null`. USDA is always-available in prod now, so a null is a
// genuine "food not found" — a *permanent* gap (an unresolvable fdc_id), not a
// transient miss to retry. computeTotals still flags it `complete: false` via
// `usdaMissesFor`, but recompute stamps such a recipe fresh (the gap is real).

// An arbitrary FoodData Central id the stub USDA backend 404s → `food: null` (a
// permanent not-found, i.e. an ingredient with an unresolvable USDA link).

describe("RecipeCostingService", () => {
  const ctx = withTestDb();

  const service = () =>
    createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } })
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
        unitMappings: [
          {
            a: { value: 1, unit: "lb" },
            b: { value: 4, unit: "dollar" },
            source: "test",
          },
        ],
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
                amounts: [{ value: 2, unit: "lb" }],
              }),
            ],
          },
        ],
      }),
      ctx.actor,
    );
  };

  describe("maintenance coordinator selection", () => {
    it("returns one empty progress event and summary without queue work", async () => {
      for (const stream of [
        recomputeAllDurableWorkflow(service()),
        recomputeStaleDurableWorkflow(service()),
      ]) {
        const events = [];
        for await (const event of stream) events.push(event);
        expect(events).toEqual([
          { type: "progress", done: 0, total: 0 },
          { type: "done", result: { enqueued: 0, total: 0 } },
        ]);
      }
    });

    it("selects active and stale work independently without writing on early close", async () => {
      const recipe = await seedPricedRecipe("Coordinator selection fixture");
      const costing = service();
      await costing.recompute([recipe.entityId]);
      const before = await getRecipeTotalsState(ctx.db, recipe.entityId);
      const all = recomputeAllDurableWorkflow(costing);
      const stale = recomputeStaleDurableWorkflow(costing);
      expect(await all.next()).toEqual({
        done: false,
        value: { type: "progress", done: 0, total: 1 },
      });
      expect(await stale.next()).toEqual({
        done: false,
        value: { type: "progress", done: 0, total: 0 },
      });
      await all.return();
      await stale.return();
      expect(await getRecipeTotalsState(ctx.db, recipe.entityId)).toEqual(
        before,
      );
    });
  });

  describe("computeTotals", () => {
    it("marks a fully-mapped recipe complete with totals present", async () => {
      const recipe = await seedPricedRecipe("Complete Recipe");
      const result = await service().computeTotals([recipe]);

      const entry = result.get(recipe.id);
      expect(entry).toBeDefined();
      expect(entry?.complete).toBe(true);
      expect(entry?.totals.cost).toMatchObject({
        status: "complete",
        coverage: { covered: 1, total: 1 },
      });
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
  });

  describe("persisted estimate list queries", () => {
    it("sorts known zero numerically and excludes unavailable or stale calories from range filters", async () => {
      const zero = await seedPricedRecipe("Zero estimate");
      const partial = await seedPricedRecipe("Partial estimate");
      const missing = await seedPricedRecipe("Missing estimate");
      const stale = await seedPricedRecipe("Stale estimate");
      const totals = (
        value: number | null,
        incomplete = false,
      ): NutritionTotals => ({
        cost: { status: "unavailable", reason: "no_data" },
        nutrition: buildNutrition((key) => {
          if (key !== "kcal" || value == null)
            return { status: "unavailable", reason: "no_data" };
          const amount = {
            lower: value,
            upper: null,
            coverage: { covered: 1, total: incomplete ? 2 : 1 },
          };
          return incomplete
            ? { status: "partial", ...amount }
            : { status: "complete", ...amount };
        }),
      });
      for (const [saved, value, isPartial] of [
        [zero, 0, false],
        [partial, 40, true],
        [missing, null, false],
        [stale, 10, false],
      ] as const) {
        await setRecipeTotalsFixtureRaw(
          ctx.db,
          saved.entityId,
          totals(value, isPartial),
          saved.id === stale.id ? null : new Date(),
        );
      }
      const filtered = await recipeList(
        ctx.db,
        { caloriesTotalMax: 50 },
        [{ orderBy: "caloriesTotal", direction: "asc" }],
        { pageSize: 20, pageIndex: 0 },
      );
      expect(filtered.data.map((entry) => entry.id)).toEqual([
        zero.id,
        partial.id,
      ]);
      const all = await recipeList(
        ctx.db,
        {},
        [{ orderBy: "caloriesTotal", direction: "asc" }],
        { pageSize: 20, pageIndex: 0 },
      );
      expect(all.data.slice(0, 2).map((entry) => entry.id)).toEqual([
        zero.id,
        partial.id,
      ]);
      expect(
        all.data.find((entry) => entry.id === stale.id)?.totals?.nutrition.kcal,
      ).toEqual({
        status: "pending",
        reason: "totals_stale",
      });
    });
  });

  describe("recompute", () => {
    it("regenerates cleared derived totals without altering authored recipe data", async () => {
      const saved = await seedPricedRecipe("Cleared nutrition cache");
      await service().recomputeQueued([saved.entityId]);
      const before = (await getRecipesByIDs(ctx.db, [saved.entityId]))[0];
      await setRecipeTotalsFixtureRaw(ctx.db, saved.entityId, null, null);
      const cleared = await getRecipeTotalsState(ctx.db, saved.entityId);
      expect(cleared?.totals).toBeNull();
      expect(cleared?.totalsComputedAt).toBeNull();
      const pending = (await getRecipesByIDs(ctx.db, [saved.entityId]))[0];
      expect(pending?.totals?.nutrition.kcal).toEqual({
        status: "pending",
        reason: "totals_missing",
      });
      expect(await selectAllStaleRecipeIds(ctx.db)).toContain(saved.entityId);
      expect(await service().recomputeQueued([saved.entityId])).toBe(1);
      const state = await getRecipeTotalsState(ctx.db, saved.entityId);
      expect(recipeTotals.safeParse(state?.totals).success).toBe(true);
      expect(state?.totalsComputedAt).toBeInstanceOf(Date);
      expect(await selectAllStaleRecipeIds(ctx.db)).not.toContain(
        saved.entityId,
      );
      const after = (await getRecipesByIDs(ctx.db, [saved.entityId]))[0];
      expect(after?.sections).toEqual(before?.sections);
      expect(after?.updatedAt).toEqual(before?.updatedAt);
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
      expect(childBefore?.totals?.cost).toMatchObject({
        status: "complete",
        lower: 4,
      });
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
      expect(childAfter?.totals?.cost).toMatchObject({
        status: "complete",
        lower: 10,
      });
      expect(parentAfter?.totalsComputedAt?.getTime() ?? 0).toBeGreaterThan(
        parentBefore?.totalsComputedAt?.getTime() ?? 0,
      );
    });
  });
});
