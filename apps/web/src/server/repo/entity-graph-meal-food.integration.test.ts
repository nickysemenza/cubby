import type { Entity } from "@cubby/schemas/entity";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { mealRecipe } from "~/server/db/schema";
import { insertAndReturn } from "~/server/repo/database-helpers";

import { getEntityGraph } from "./entity-graph";
import { createLedgerParty } from "./ledger-party";
import { createMealWithEntityId } from "./meal/crud";
import { saveMealFood } from "./meal/food";
import { saveMealRecipePreparation } from "./meal/portions";
import { loadRelatedPreviews } from "./related-view";
import {
  createProductFixture as createProduct,
  makeProductInput,
} from "./repo.fixtures";
import { insertWithShortcode } from "./shortcode-utils";

/**
 * Regression for PRD-KMK2: `MealFoodEntry` (product/ingredient, ledgerParty,
 * meal) and `MealRecipePortion` (ledgerParty, meal, mealRecipe) previously had
 * zero manifest-relation coverage, so a product's food entry at a meal was
 * invisible on the Relations tab / entity graph even though the FK existed.
 * This test pins the declared relations plus the graph-dedupe fix that keeps
 * a two-source relation (e.g. `meal.eaters` / `ledgerParty.meals`, each with a
 * primary food-entry source and a secondary "portions" source) from leaking a
 * stray synthesized `inverse:*` branch on the other side.
 */
describe("entity graph meal/food-entry relationships", () => {
  const ctx = withTestDb();

  it("follows product/ledgerParty <-> meal relations declared over MealFoodEntry and MealRecipePortion", async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: "Food-entry product" }),
      ctx.actor,
    );
    const party = await createLedgerParty(
      ctx.db,
      { name: "Food-entry eater", kind: "member", notes: null },
      ctx.actor,
    );
    const meal = await createMealWithEntityId(
      ctx.db,
      { date: "2026-09-14", name: "Food-entry lunch" },
      ctx.actor,
    );

    await saveMealFood(
      ctx.db,
      {
        sourceKind: "product",
        mealId: meal.output.id,
        ledgerPartyId: party.output.id,
        productId: product.id,
        amount: { value: 100, unit: "g" },
      },
      ctx.actor,
    );

    const follow = async (
      source: { entityType: Entity; entityId: string },
      relationshipKey: string,
      target: { entityType: Entity; entityId: string },
    ) => {
      const graph = await getEntityGraph(ctx.db, {
        roots: [source],
        relationshipKeys: [relationshipKey],
      });
      expect(graph.branches).toContainEqual(
        expect.objectContaining({
          root: source,
          relationshipKey,
          target: target.entityType,
          items: expect.arrayContaining([target]),
        }),
      );
    };

    // The PRD-KMK2 case: a product-kind food entry links product <-> meal.
    await follow({ entityType: "product", entityId: product.id }, "meals", {
      entityType: "meal",
      entityId: meal.output.id,
    });
    await follow(
      { entityType: "meal", entityId: meal.output.id },
      "food-products",
      { entityType: "product", entityId: product.id },
    );

    // The same food entry also links product/meal <-> ledgerParty (eater).
    await follow({ entityType: "product", entityId: product.id }, "eaters", {
      entityType: "ledgerParty",
      entityId: party.output.id,
    });
    await follow(
      { entityType: "ledgerParty", entityId: party.output.id },
      "meals",
      { entityType: "meal", entityId: meal.output.id },
    );
    await follow({ entityType: "meal", entityId: meal.output.id }, "eaters", {
      entityType: "ledgerParty",
      entityId: party.output.id,
    });

    // A served portion reaches a recipe via `MealRecipePortion`, and a
    // portion served at a LATER meal (leftovers) reaches that meal only
    // through the secondary "portions" source of `ledgerParty.meals` /
    // `meal.eaters`. Both relations declare a primary (food-entry) source and
    // that secondary source, so each source's inverse must be checked when
    // the graph decides whether to synthesize a stray `inverse:*` branch on
    // the other side.
    // A stated yield keeps the two 100 g portions inside the batch guard.
    const recipe = await insertWithShortcode(ctx.db, "recipe", {
      name: "Food-entry stew",
      yield: { value: 400, unit: "g" },
    });
    const leftoversMeal = await createMealWithEntityId(
      ctx.db,
      { date: "2026-09-15", name: "Food-entry leftovers" },
      ctx.actor,
    );
    const occurrence = await insertAndReturn(ctx.db, mealRecipe, {
      mealId: meal.entityId,
      recipeId: recipe.id,
      scale: 1,
    });
    await saveMealRecipePreparation(
      ctx.db,
      {
        mealRecipeId: occurrence.id,
        actualYieldGrams: 400,
        changes: [
          {
            action: "set",
            mealId: meal.output.id,
            ledgerPartyId: party.output.id,
            amount: { value: 100, unit: "g" },
            confirmed: false,
          },
          {
            action: "set",
            mealId: leftoversMeal.output.id,
            ledgerPartyId: party.output.id,
            amount: { value: 100, unit: "g" },
            confirmed: false,
          },
        ],
      },
      ctx.actor,
    );

    await follow(
      { entityType: "ledgerParty", entityId: party.output.id },
      "recipes-eaten",
      { entityType: "recipe", entityId: recipe.shortcode },
    );
    // The graph unions both sources, so the portion-only meal is reachable.
    await follow(
      { entityType: "ledgerParty", entityId: party.output.id },
      "meals",
      { entityType: "meal", entityId: leftoversMeal.output.id },
    );

    // Full expansion from meal: exactly one `eaters` branch, and no leaked
    // `inverse:ledgerParty.meals` branch carrying only the "portions" source.
    const mealGraph = await getEntityGraph(ctx.db, {
      roots: [{ entityType: "meal", entityId: meal.output.id }],
    });
    const eaterKeyedBranches = mealGraph.branches.filter(
      (branch) =>
        branch.relationshipKey === "eaters" ||
        branch.relationshipKey.startsWith("inverse:ledgerParty."),
    );
    expect(eaterKeyedBranches).toHaveLength(1);
    expect(eaterKeyedBranches[0]).toMatchObject({ relationshipKey: "eaters" });
    expect(
      mealGraph.branches.some(
        (branch) => branch.relationshipKey === "inverse:ledgerParty.meals",
      ),
    ).toBe(false);

    // Related views compile only the primary source (`relatedViewPath` in
    // `packages/schemas/src/related-view.ts`), so the list column sees the
    // food-entry meal and not the portion-only leftovers meal.
    const previews = await loadRelatedPreviews(ctx.db, {
      source: "ledgerParty",
      sourceIds: [party.output.id],
      relationKeys: ["ledgerParty.meals"],
    });
    const mealsPreview = previews.find(
      (group) => group.relationKey === "ledgerParty.meals",
    );
    expect(mealsPreview?.totalCount).toBe(1);
    expect(mealsPreview?.items).toEqual([
      expect.objectContaining({ entity: "meal", id: meal.output.id }),
    ]);
  });
});
