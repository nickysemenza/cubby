import type { BackgroundBatchRef } from "@cubby/schemas/background-jobs";
import type { IngredientId, ProductId } from "@cubby/schemas/identifiers";
import { describe, expect, it, vi } from "vitest";
import { updateProductWithSideEffects } from "./product-orchestration.service";

vi.mock("./mutation-side-effects", () => ({
  runMutationSideEffects: vi.fn().mockResolvedValue([]),
}));

describe("updateProductWithSideEffects", () => {
  it("recomputes recipes for both previous and current ingredients when reassigned", async () => {
    const productId = "00000000-0000-4000-8000-000000000001" as ProductId;
    const oldIngredientId =
      "00000000-0000-4000-8000-000000000002" as IngredientId;
    const newIngredientId =
      "00000000-0000-4000-8000-000000000003" as IngredientId;
    const product = {
      getProductByID: vi.fn().mockResolvedValueOnce({
        id: productId,
        ingredient: { id: oldIngredientId },
      }),
      updateProduct: vi.fn().mockResolvedValue({
        id: productId,
        ingredient: { id: newIngredientId },
      }),
    };
    const recipeCosting = {
      recomputeForIngredients: vi.fn().mockResolvedValue([recipeBatch]),
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
      { ingredientId: newIngredientId },
      {} as never,
    );

    expect(product.getProductByID).toHaveBeenCalledWith(productId);
    expect(recipeCosting.recomputeForIngredients).toHaveBeenCalledWith(
      [oldIngredientId, newIngredientId],
      {
        source: "product.update",
        entity: { entityType: "product", entityId: productId },
      },
    );
    expect(locationValuation.recompute).not.toHaveBeenCalled();
    expect(result.sideEffects.backgroundBatches).toEqual([recipeBatch]);
  });
});
const recipeBatch = {
  id: "00000000-0000-4000-8000-000000000010",
  kind: "recipe-totals.recompute",
  source: "mutation",
  processor: "inline",
  status: "succeeded",
  totalJobs: 1,
} satisfies BackgroundBatchRef;
