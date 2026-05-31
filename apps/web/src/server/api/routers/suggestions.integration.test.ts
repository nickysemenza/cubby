import { recipeAvailabilityOut } from "@cubby/schemas/availability";
import type { Amount } from "@cubby/schemas/codec";
import { buildActorContext } from "@cubby/schemas/context";
import {
  unsafeIngredientId,
  unsafeLocationId,
  unsafeRecipeId,
  unsafeUserId,
} from "@cubby/schemas/identifiers";
import { buildTestDB } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "~/server/db";
import { findOrCreateIngredient } from "~/server/repo/ingredient";
import { createInventoryEntry } from "~/server/repo/inventory";
import { createLocation } from "~/server/repo/location";
import { createProduct } from "~/server/repo/product";
import { createCallerFactory, createTestTRPCContext } from "../trpc";
import { recipeRouter } from "./recipe";
import { suggestionsRouter } from "./suggestions";

const TEST_USER_ID = unsafeUserId("test-user-id");
const ACTOR = buildActorContext(TEST_USER_ID, "ui");

const CUP_TO_GRAM = {
  a: { value: 1, unit: "cup" },
  b: { value: 120, unit: "g" },
  source: null,
};

const makeRecipeCaller = createCallerFactory(recipeRouter);
const makeSuggestionsCaller = createCallerFactory(suggestionsRouter);

describe("suggestions router", () => {
  let db: Database;
  let teardown: () => Promise<void>;
  // Built fresh per test from a single shared context — multiple independent
  // contexts can land on divergent pooled-connection snapshots.
  let recipeCaller: ReturnType<typeof makeRecipeCaller>;
  let suggestionsCaller: ReturnType<typeof makeSuggestionsCaller>;

  beforeEach(async () => {
    ({ db, teardown } = await buildTestDB());
    const ctx = createTestTRPCContext(db, { auth: { userId: TEST_USER_ID } });
    recipeCaller = makeRecipeCaller(ctx);
    suggestionsCaller = makeSuggestionsCaller(ctx);
    return teardown;
  });

  // Single-ingredient recipe asking for `need` of `ingredientId`.
  const createRecipe = (name: string, ingredientId: string, need: Amount) =>
    recipeCaller.create({
      name,
      meta: null,
      sections: [
        {
          ingredients: [
            {
              type: "ingredient" as const,
              ingredientId,
              recipeId: null,
              amounts: [need],
            },
          ],
          instructions: [{ instruction: "Mix" }],
        },
      ],
      images: [],
    });

  // Ingredient with a linked product (cup<->g mapped) holding `onHand`.
  const seedIngredientWithStock = async (name: string, onHand: Amount) => {
    const ing = await findOrCreateIngredient(db, name);
    const loc = await createLocation(
      db,
      { name: `Pantry-${name}`, type: "room", parentId: null },
      ACTOR,
    );
    if (!loc) throw new Error("seed: location not created");
    const prod = await createProduct(
      db,
      {
        name: `Test ${name}`,
        manufacturer: "test",
        upc: null,
        ndb_number: null,
        expectedQuantity: null,
        ingredientId: unsafeIngredientId(ing.id),
        unitMappings: [CUP_TO_GRAM],
        externalIds: [],
      },
      ACTOR,
    );
    await createInventoryEntry(
      db,
      {
        productId: prod.id,
        locationId: unsafeLocationId(loc.id),
        amount: onHand,
      },
      ACTOR,
    );
    return ing;
  };

  it("getRecipeAvailability output satisfies the published schema", async () => {
    const flour = await seedIngredientWithStock("flour", {
      value: 500,
      unit: "g",
    });
    const recipe = await createRecipe("Pancakes", flour.id, {
      value: 2,
      unit: "cup",
    });

    const result = await suggestionsCaller.getRecipeAvailability({
      recipeId: unsafeRecipeId(recipe.id),
    });

    // The .output() contract must accept real service output (pins schema<->service).
    expect(() => recipeAvailabilityOut.parse(result)).not.toThrow();
    expect(result.coverage).toBe(1);
  });

  it("getMakeable ranks by coverage desc and honors minCoverage", async () => {
    // "Ready Recipe": fully stocked. "Short Recipe": stocked but insufficient.
    const flour = await seedIngredientWithStock("flour", {
      value: 500,
      unit: "g",
    });
    const sugar = await seedIngredientWithStock("sugar", {
      value: 10,
      unit: "g",
    });
    await createRecipe("Ready Recipe", flour.id, { value: 2, unit: "cup" });
    await createRecipe("Short Recipe", sugar.id, { value: 2, unit: "cup" });

    const all = await suggestionsCaller.getMakeable({});
    expect(all).toHaveLength(2);
    expect(all[0]?.coverage).toBeGreaterThanOrEqual(all[1]?.coverage ?? 0);
    expect(all[0]?.recipeName).toBe("Ready Recipe");

    const readyOnly = await suggestionsCaller.getMakeable({ minCoverage: 1 });
    expect(readyOnly).toHaveLength(1);
    expect(readyOnly[0]?.recipeName).toBe("Ready Recipe");
  });
});
