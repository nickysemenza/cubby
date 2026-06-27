import { describe, expect, it } from "vitest";
import {
  ingredientAllMutationInvalidateKeys,
  ingredientMutationInvalidateKeys,
  ingredientProductMutationInvalidateKeys,
  ingredientRecipeMutationInvalidateKeys,
  inventoryMutationInvalidateKeys,
  locationMutationInvalidateKeys,
  mealMutationInvalidateKeys,
  normalizeTRPCQueryKey,
  problemsMutationInvalidateKeys,
  productLookupMutationInvalidateKeys,
  productMutationInvalidateKeys,
  productRecipeMutationInvalidateKeys,
  queryKeys,
  recipeAllMutationInvalidateKeys,
  recipeCookbookMutationInvalidateKeys,
  recipeMutationInvalidateKeys,
} from "./query-keys";

describe("normalizeTRPCQueryKey", () => {
  it("wraps canonical router keys in the tRPC query-key tuple", () => {
    expect(normalizeTRPCQueryKey(["product"])).toEqual([["product"]]);
    expect(normalizeTRPCQueryKey(["inventory", "list"])).toEqual([
      ["inventory", "list"],
    ]);
  });

  it("leaves generated tRPC query keys unchanged", () => {
    const key = [["product", "list"], { input: { json: null } }];
    expect(normalizeTRPCQueryKey(key)).toBe(key);
  });
});

describe("mutation invalidation groups", () => {
  it("keeps inventory mutations broad enough for dependent surfaces", () => {
    expect(inventoryMutationInvalidateKeys).toEqual([
      queryKeys.inventory.all,
      queryKeys.location.all,
      queryKeys.product.all,
      queryKeys.problems.all,
      queryKeys.search.all,
      queryKeys.dashboard.counts,
    ]);
  });

  it("keeps single-entity mutation groups explicit", () => {
    expect(productMutationInvalidateKeys).toEqual([queryKeys.product.all]);
    expect(locationMutationInvalidateKeys).toEqual([queryKeys.location.list]);
    expect(ingredientMutationInvalidateKeys).toEqual([
      queryKeys.ingredient.list,
    ]);
    expect(ingredientAllMutationInvalidateKeys).toEqual([
      queryKeys.ingredient.all,
    ]);
    expect(recipeMutationInvalidateKeys).toEqual([queryKeys.recipe.list]);
    expect(recipeCookbookMutationInvalidateKeys).toEqual([
      queryKeys.recipe.list,
      queryKeys.recipe.listCookbooks,
    ]);
    expect(recipeAllMutationInvalidateKeys).toEqual([queryKeys.recipe.all]);
    expect(problemsMutationInvalidateKeys).toEqual([queryKeys.problems.all]);
    expect(mealMutationInvalidateKeys).toEqual([queryKeys.meal.all]);
  });

  it("keeps cross-entity mutation groups explicit", () => {
    expect(productRecipeMutationInvalidateKeys).toEqual([
      queryKeys.product.all,
      queryKeys.recipe.list,
    ]);
    expect(productLookupMutationInvalidateKeys).toEqual([
      queryKeys.product.all,
      queryKeys.problems.all,
      queryKeys.search.all,
    ]);
    expect(ingredientProductMutationInvalidateKeys).toEqual([
      queryKeys.ingredient.all,
      queryKeys.product.all,
    ]);
    expect(ingredientRecipeMutationInvalidateKeys).toEqual([
      queryKeys.ingredient.all,
      queryKeys.recipe.all,
    ]);
  });
});
