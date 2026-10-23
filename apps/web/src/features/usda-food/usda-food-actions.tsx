import type {
  IngredientShortcode,
  VendorShortcode,
} from "@cubby/schemas/identifiers";
import type { FoodSummaryWithLinkedProducts } from "@cubby/schemas/usda";
import { LinkIcon } from "@phosphor-icons/react/dist/csr/Link";
import { StackPlusIcon } from "@phosphor-icons/react/dist/csr/StackPlus";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { productCreateRequest } from "~/entity/editing/editor-requests";
import { EntityEditDialog } from "~/entity/editing/entity-edit-dialog";
import { EntityReferencePicker } from "~/entity/picker/entity-reference-picker";
import { useProductBrandIngress } from "~/features/product/use-product-brand-ingress";
import type { ComboboxItem } from "~/ui/combobox/combobox-types";
import { showErrorToast } from "~/ui/feedback/error-details";
import { Row } from "~/ui/layout";
import { Overlay } from "~/ui/overlays/overlay";
import { Button } from "~/ui/primitives/button";

/** Both actions create a Product: USDA links belong to Products, not ingredients. */
export function UsdaFoodActions({
  food,
}: {
  food: FoodSummaryWithLinkedProducts;
}) {
  const router = useRouter();
  const brands = useProductBrandIngress();
  const [flow, setFlow] = useState<"product" | "ingredient" | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [brandId, setBrandId] = useState<VendorShortcode | null>(null);
  const [ingredient, setIngredient] =
    useState<ComboboxItem<IngredientShortcode> | null>(null);
  const foodName = food.foodInfo.description || "this food";

  const open = async (next: "product" | "ingredient") => {
    if (preparing) return;
    setPreparing(true);
    try {
      // The marketed brand is stronger identity evidence than its corporate owner.
      const brand = await brands.resolve(
        food.brandedFoodInfo?.brand_name || food.brandedFoodInfo?.brand_owner,
      );
      setBrandId(brand);
      setFlow(next);
    } catch (error) {
      showErrorToast(error, "Could not prepare Product");
    } finally {
      setPreparing(false);
    }
  };
  const onOpenChange = (next: boolean) => {
    if (!next) {
      setFlow(null);
      setIngredient(null);
    }
  };

  return (
    <>
      <Row gap="sm">
        <Button
          variant="outline"
          size="sm"
          disabled={preparing}
          onClick={() => void open("product")}
        >
          <StackPlusIcon />
          Create product from this food
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={preparing}
          onClick={() => void open("ingredient")}
        >
          <LinkIcon />
          Link to an ingredient
        </Button>
      </Row>
      <Overlay
        open={flow === "ingredient" && !ingredient}
        onOpenChange={onOpenChange}
        size="xl"
        title={`Link ${foodName} to an ingredient`}
        description="Choose the ingredient this food should back — a new product carrying the USDA link is created for it."
        onCancel={() => onOpenChange(false)}
      >
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
      </Overlay>
      <EntityEditDialog
        open={
          flow === "product" || (flow === "ingredient" && ingredient !== null)
        }
        onOpenChange={onOpenChange}
        request={productCreateRequest({
          name: food.foodInfo.description || undefined,
          brandId,
          barcode: food.brandedFoodInfo?.gtin_upc ?? null,
          fdcId: food.fdc_id,
          ingredientId: ingredient?.id,
        })}
        onSuccess={() => {
          void router.invalidate();
          onOpenChange(false);
        }}
      />
    </>
  );
}
