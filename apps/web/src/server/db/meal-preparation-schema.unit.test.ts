import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { mealFoodEntry, mealRecipe, mealRecipePortion } from "./schema";

describe("meal preparation storage schema", () => {
  it("stores nullable positive whole-gram yields on MealRecipe", () => {
    const config = getTableConfig(mealRecipe);

    expect(config.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(["estimatedYieldGrams", "actualYieldGrams"]),
    );
    expect(config.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        "MealRecipe_estimatedYieldGrams_check",
        "MealRecipe_actualYieldGrams_check",
      ]),
    );
  });

  it("enforces one live portion per source occurrence, target meal, and eater", () => {
    const config = getTableConfig(mealRecipePortion);

    expect(config.name).toBe("MealRecipePortion");
    expect(config.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "mealRecipeId",
        "mealId",
        "ledgerPartyId",
        "amount",
        "confirmedAt",
        "deletedAt",
      ]),
    );
    expect(config.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining(["MealRecipePortion_amount_check"]),
    );

    const liveKey = config.indexes.find(
      (index) =>
        index.config.name === "MealRecipePortion_live_source_target_eater_key",
    );
    expect(liveKey?.config.unique).toBe(true);
    expect(liveKey?.config.where).toBeDefined();
  });

  it("indexes every portion foreign key and cascades hard deletion of its source occurrence", () => {
    const config = getTableConfig(mealRecipePortion);
    expect(config.indexes.map((index) => index.config.name)).toEqual(
      expect.arrayContaining([
        "MealRecipePortion_mealRecipeId_idx",
        "MealRecipePortion_mealId_idx",
        "MealRecipePortion_ledgerPartyId_idx",
      ]),
    );

    const sourceForeignKey = config.foreignKeys.find(
      (foreignKey) =>
        foreignKey.reference().columns[0]?.name === "mealRecipeId",
    );
    expect(sourceForeignKey?.onDelete).toBe("cascade");
  });

  it("stores exclusive ingredient, product, and manual food sources with canonical amounts", () => {
    const config = getTableConfig(mealFoodEntry);

    expect(config.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "sourceKind",
        "ingredientId",
        "productId",
        "amount",
        "name",
        "nutrients",
      ]),
    );
    expect(config.indexes.map((index) => index.config.name)).toContain(
      "MealFoodEntry_ingredientId_idx",
    );
    expect(config.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        "MealFoodEntry_amount_check",
        "MealFoodEntry_source_check",
      ]),
    );
    expect(
      config.foreignKeys.some(
        (foreignKey) =>
          foreignKey.reference().columns[0]?.name === "ingredientId",
      ),
    ).toBe(true);
  });
});
