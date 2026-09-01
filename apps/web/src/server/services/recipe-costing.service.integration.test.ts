import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { updateProduct } from "~/server/repo/product";
import { getRecipeTotalsState } from "~/server/repo/recipe/totals";

import { findOrCreateIngredient } from "../repo/ingredient";
import {
  createProductFixture as createProduct,
  createRecipeFixture as createRecipe,
  ingredientRef,
  makeProductInput,
  makeRecipeInput,
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

  describe("recompute", () => {
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
});
