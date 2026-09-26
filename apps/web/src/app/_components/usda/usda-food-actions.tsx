import type { IngredientShortcode } from "@cubby/schemas/identifiers";
import type { FoodSummaryWithLinkedProducts } from "@cubby/schemas/usda";
import { LinkIcon } from "@phosphor-icons/react/dist/csr/Link";
import { StackPlusIcon } from "@phosphor-icons/react/dist/csr/StackPlus";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { EntityReferencePicker } from "~/app/_components/combobox/entity-reference-picker";
import { Row } from "~/components/layout";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { productCreateRequest } from "~/entities/editing/editor-requests";
import { EntityEditDialog } from "~/entities/editing/entity-edit-dialog";

import type { ComboboxItem } from "../combobox/combobox-types";

/**
 * USDA-food-derived prefill shared by both actions below: manufacturer/UPC/
 * fdc_id only. `category` is deliberately not prefilled — it self-corrects
 * server-side via `hasFoodIndicators` once `fdc_id` is set.
 */
function foodProductPrefill(food: FoodSummaryWithLinkedProducts) {
  return {
    name: food.foodInfo.description || undefined,
    manufacturer:
      food.brandedFoodInfo?.brand_owner ??
      food.brandedFoodInfo?.brand_name ??
      undefined,
    upc: food.brandedFoodInfo?.gtin_upc ?? null,
    fdcId: food.fdc_id,
  };
}

function CreateProductFromFoodButton({
  food,
}: {
  food: FoodSummaryWithLinkedProducts;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <StackPlusIcon />
        Create product from this food
      </Button>
      <EntityEditDialog
        open={open}
        onOpenChange={setOpen}
        request={productCreateRequest(foodProductPrefill(food))}
        onSuccess={() => void router.invalidate()}
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
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [ingredient, setIngredient] =
    useState<ComboboxItem<IngredientShortcode> | null>(null);
  const foodName = food.foodInfo.description || "this food";

  const handleOpenChange = (next: boolean) => {
    if (!next) setIngredient(null);
    setOpen(next);
  };

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <LinkIcon />
        Link to an ingredient
      </Button>
      <Dialog open={open && !ingredient} onOpenChange={handleOpenChange}>
        <DialogContent size="xl">
          <DialogHeader>
            <DialogTitle>Link {foodName} to an ingredient</DialogTitle>
            <DialogDescription>
              Choose the ingredient this food should back — a new product
              carrying the USDA link is created for it.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4">
            <EntityReferencePicker
              entity="ingredient"
              creatable
              label="ingredient"
              value={ingredient}
              setValue={setIngredient}
              openOnMount
              placeholder="Search ingredients…"
            />
          </div>
        </DialogContent>
      </Dialog>
      {/* Step 2 — the generic create dialog, prefilled from the food and the
          ingredient chosen above (closes the `ingredient → product → fdc_id`
          hop in one save). */}
      <EntityEditDialog
        open={open && ingredient !== null}
        onOpenChange={handleOpenChange}
        request={productCreateRequest({
          ...foodProductPrefill(food),
          ingredientId: ingredient?.id,
        })}
        onSuccess={() => {
          void router.invalidate();
          handleOpenChange(false);
        }}
      />
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
