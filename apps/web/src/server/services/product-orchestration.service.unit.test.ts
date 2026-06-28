import type { IngredientId, ProductId } from "@cubby/schemas/identifiers";
import { describe, expect, it, vi } from "vitest";
import { updateProductWithSideEffects } from "./product-orchestration.service";

describe("updateProductWithSideEffects", () => {
  it("recomputes recipes for both previous and current ingredients when reassigned", async () => {
    const productId = "p-1" as ProductId;
    const product = {
      getProductByID: vi.fn().mockResolvedValueOnce({
        id: productId,
        ingredient: { id: "ing-old" },
      }),
      updateProduct: vi
        .fn()
        .mockResolvedValue({ id: productId, ingredient: { id: "ing-new" } }),
    };
    const recipeCosting = {
      recomputeForIngredients: vi.fn().mockResolvedValue(7),
    };
    const locationValuation = {
      recompute: vi.fn(),
    };

    const result = await updateProductWithSideEffects(
      {
        db: {} as never,
        product: product as never,
        recipeCosting: recipeCosting as never,
        locationValuation: locationValuation as never,
      },
      productId,
      { ingredientId: "ing-new" as IngredientId },
      {} as never,
    );

    expect(product.getProductByID).toHaveBeenCalledWith(productId);
    expect(recipeCosting.recomputeForIngredients).toHaveBeenCalledWith([
      "ing-old",
      "ing-new",
    ]);
    expect(locationValuation.recompute).not.toHaveBeenCalled();
    expect(result.sideEffects.recipesRecomputed).toBe(7);
    expect(result.sideEffects.inventoryValuationsUpdated).toBe(0);
  });
});
