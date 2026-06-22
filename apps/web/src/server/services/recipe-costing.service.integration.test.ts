import type { RecipeId } from "@cubby/schemas/identifiers";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { createProduct } from "~/server/repo/product";
import {
  createRecipe,
  getRecipesByIDs,
  updateRecipe,
} from "~/server/repo/recipe";
import { getRecipeTotalsState } from "~/server/repo/recipe/totals";
import { createTestTRPCContext } from "../api/trpc";
import { findOrCreateIngredient } from "../repo/ingredient";
import {
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
              ingredientRef(ing.id, { amounts: [{ value: 2, unit: "cup" }] }),
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

      const entry = result.get(recipe.id as RecipeId);
      expect(entry).toBeDefined();
      expect(entry?.complete).toBe(true);
      expect(entry?.totals.ingredientCount).toBe(1);
    });

    it("marks a recipe with an unresolved USDA link incomplete", async () => {
      const ing = await findOrCreateIngredient(ctx.db, "usda flour");
      // fdc_id set but the USDA backend is unreachable in tests, so `food`
      // resolves null → a transient miss → complete: false.
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
                ingredientRef(ing.id, { amounts: [{ value: 1, unit: "cup" }] }),
              ],
            },
          ],
        }),
        ctx.actor,
      );

      const entry = (await service().computeTotals([recipe])).get(
        recipe.id as RecipeId,
      );
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
      expect(result.get(a.id as RecipeId)).toBeDefined();
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
        a.id as RecipeId,
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

      const [reloadedA] = await getRecipesByIDs(ctx.db, [a.id as RecipeId]);
      // Should resolve (not hang); the result map contains A.
      const result = await service().computeTotals([reloadedA!]);
      expect(result.get(a.id as RecipeId)).toBeDefined();
    });
  });

  describe("recompute", () => {
    it("persists totals and stamps a complete recipe fresh", async () => {
      const recipe = await seedPricedRecipe("Persist Recipe");
      await service().recompute([recipe.id as RecipeId]);

      const state = await getRecipeTotalsState(ctx.db, recipe.id as RecipeId);
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
                ingredientRef(ing.id, { amounts: [{ value: 1, unit: "cup" }] }),
              ],
            },
          ],
        }),
        ctx.actor,
      );

      await service().recompute([recipe.id as RecipeId]);
      const state = await getRecipeTotalsState(ctx.db, recipe.id as RecipeId);
      expect(state?.totals).not.toBeNull();
      // USDA is reliable now, so an unresolved fdc_id is a permanent costing gap
      // (surfaced by the coverage UI), not a stale-for-retry row — stamp fresh.
      expect(state?.totalsComputedAt).not.toBeNull();
    });

    it("eagerly recomputes a parent when a child sub-recipe changes", async () => {
      const child = await seedPricedRecipe("Cascade Child");
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

      // Stamp the parent fresh, but with empty totals (child not yet computed).
      await service().recompute([parent.id as RecipeId]);
      const before = await getRecipeTotalsState(ctx.db, parent.id as RecipeId);
      expect(before?.totalsComputedAt).not.toBeNull();

      // Recompute the child: its totals change (none → some), so recompute
      // cascades eagerly into the parent — which stays fresh and now reflects
      // the child's cost (no drain hop).
      await service().recompute([child.id as RecipeId]);

      const after = await getRecipeTotalsState(ctx.db, parent.id as RecipeId);
      expect(after?.totalsComputedAt).not.toBeNull();
      expect(after?.totals?.costTotal).toBeGreaterThan(
        before?.totals?.costTotal ?? 0,
      );
    });
  });
});
