import type { IngredientShortcode } from "@cubby/schemas/identifiers";
import type { ProductCreateInput } from "@cubby/schemas/product";
import type { FoodSummaryWithLinkedProducts } from "@cubby/schemas/usda";
import { useRouter } from "@tanstack/react-router";
import { Link2, PackagePlus } from "lucide-react";
import { useState } from "react";
import { Row } from "~/components/layout";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { useTRPC } from "~/integrations/trpc/react";
import { getErrorMessage } from "~/lib/error-utils";
import {
  ingredientProductMutationInvalidateKeys,
  productMutationInvalidateKeys,
  queryKeys,
} from "~/lib/query-keys";
import { savedWithBackgroundWork } from "~/lib/recompute-summary";
import type { ComboboxItem } from "../combobox/combobox-types";
import { CreateProductDialog } from "../combobox/create-entity-dialogs";
import { EntityPicker } from "../combobox/entity-picker";
import { WithIngredientSearch } from "../combobox/with-search-hook";
import { useActionMutation } from "../hooks/useActionMutation";
import { ProductForm } from "../products/product-form";

/**
 * USDA-food-derived prefill shared by both actions below: manufacturer/UPC/
 * fdc_id only. `category` is deliberately not prefilled — it self-corrects
 * server-side via `hasFoodIndicators` once `fdc_id` is set.
 */
function foodProductPrefill(food: FoodSummaryWithLinkedProducts) {
  return {
    initialName: food.foodInfo.description || undefined,
    initialManufacturer:
      food.brandedFoodInfo?.brand_owner ??
      food.brandedFoodInfo?.brand_name ??
      undefined,
    initialUpc: food.brandedFoodInfo?.gtin_upc ?? null,
    initialFdcId: food.fdc_id,
  };
}

function CreateProductFromFoodButton({
  food,
}: {
  food: FoodSummaryWithLinkedProducts;
}) {
  const api = useTRPC();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const foodName = food.foodInfo.description || "this food";

  const createProduct = useActionMutation({
    entity: "product",
    mutationFn: api.product.create.mutationOptions,
    success: (product) =>
      savedWithBackgroundWork(
        product.sideEffects,
        `Created ${product.name} from ${foodName}`,
      ),
    // The new product's fdc_id resolves back onto this food's linkedProducts.
    invalidateKeys: [...productMutationInvalidateKeys, queryKeys.usda.all],
    onSuccess: () => {
      void router.invalidate();
      setOpen(false);
    },
    error: (err) => `Failed to create product: ${getErrorMessage(err)}`,
  });

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <PackagePlus />
        Create product from this food
      </Button>
      <CreateProductDialog
        isOpen={open}
        onOpenChange={setOpen}
        onCancel={() => setOpen(false)}
        onCreate={(data: ProductCreateInput) => createProduct.mutate(data)}
        isPending={createProduct.isPending}
        error={createProduct.error?.message}
        {...foodProductPrefill(food)}
      />
    </>
  );
}

/**
 * "Link to an ingredient" is a two-step flow, not a plain update: `fdc_id` is
 * product-only (Tenet 2), so there is no product to link an ingredient onto
 * until one exists. Step 1 picks (or creates) the ingredient; step 2 opens
 * the same USDA-prefilled product form as the create action above, pre-seeded
 * with that ingredient — closing the `ingredient → product → fdc_id` hop in
 * one save. Mirrors `EnrichIngredientDialog`, run in the opposite direction
 * (there the ingredient is already known; here the food is).
 */
function LinkFoodToIngredientButton({
  food,
}: {
  food: FoodSummaryWithLinkedProducts;
}) {
  const api = useTRPC();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [ingredient, setIngredient] =
    useState<ComboboxItem<IngredientShortcode> | null>(null);
  const foodName = food.foodInfo.description || "this food";

  const handleOpenChange = (next: boolean) => {
    if (!next) setIngredient(null);
    setOpen(next);
  };

  const createProduct = useActionMutation({
    entity: "product",
    mutationFn: api.product.create.mutationOptions,
    success: (product) =>
      savedWithBackgroundWork(
        product.sideEffects,
        `Linked ${foodName} to ${ingredient?.name ?? "ingredient"}`,
      ),
    invalidateKeys: [
      ...ingredientProductMutationInvalidateKeys,
      queryKeys.usda.all,
    ],
    onSuccess: () => {
      void router.invalidate();
      handleOpenChange(false);
    },
    error: (err) => `Failed to create product: ${getErrorMessage(err)}`,
  });

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Link2 />
        Link to an ingredient
      </Button>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent size="xl">
          {!ingredient ? (
            <>
              <DialogHeader>
                <DialogTitle>Link {foodName} to an ingredient</DialogTitle>
                <DialogDescription>
                  Choose the ingredient this food should back — a new product
                  carrying the USDA link is created for it.
                </DialogDescription>
              </DialogHeader>
              <div className="mt-4">
                <WithIngredientSearch>
                  {({
                    items,
                    onSearchChange,
                    isLoading,
                    onCreateNew,
                    onOpenChange,
                  }) => (
                    <EntityPicker
                      entity="ingredient"
                      label="ingredient"
                      items={items}
                      value={ingredient}
                      setValue={setIngredient}
                      onSearchChange={onSearchChange}
                      isLoading={isLoading}
                      onCreateNew={onCreateNew}
                      onOpenChange={onOpenChange}
                      autoFocus
                      placeholder="Search ingredients…"
                    />
                  )}
                </WithIngredientSearch>
              </div>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Create product for {ingredient.name}</DialogTitle>
                <DialogDescription>
                  Prefilled from {foodName}.
                </DialogDescription>
              </DialogHeader>
              <div className="mt-4">
                <ProductForm
                  mode="create"
                  isPending={createProduct.isPending}
                  error={createProduct.error?.message}
                  onCancel={() => setIngredient(null)}
                  onCreate={(payload: ProductCreateInput) =>
                    createProduct.mutate(payload)
                  }
                  initialIngredient={ingredient}
                  embedded
                  {...foodProductPrefill(food)}
                />
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * The USDA food detail page's two mutating actions. Both create a product
 * rather than writing anywhere else — `fdc_id` is product-only (Tenet 2), so
 * closing the `ingredient → product → fdc_id` hop from the food side always
 * means minting (or reusing) a product.
 */
export function UsdaFoodActions({
  food,
}: {
  food: FoodSummaryWithLinkedProducts;
}) {
  return (
    <Row gap="sm">
      <CreateProductFromFoodButton food={food} />
      <LinkFoodToIngredientButton food={food} />
    </Row>
  );
}
