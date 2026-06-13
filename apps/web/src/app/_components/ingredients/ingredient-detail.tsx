import type { IngredientUpdateInput } from "@cubby/schemas/ingredient";
import {
  Apple,
  ChefHat,
  Info,
  Scale,
  ShoppingCart,
  Sparkles,
} from "lucide-react";
import { type FC, useState } from "react";
import { MutedBox } from "~/components/layout/muted-box";
import { Button } from "~/components/ui/button";
import { getIngredientMappings } from "~/lib/unit-mapping-utils";
import type { IngredientWithFoodOut } from "~/server/services/ingredient.service";
import { useTRPC } from "~/trpc/react";
import { DetailPage, type DetailSection } from "../data-table/detail-page";
import { EntityPillLinkList } from "../EntityPillLinkList";
import { useEntityDetail } from "../hooks/useEntityDetail";
import { ConversionCapabilities } from "../units/ConversionCapabilities";
import { UnitMappingsTable } from "../units/unitmappingstable";
import { NutritionInfoTable } from "../usda/nutrition";
import { EnrichIngredientDialog } from "./enrich-ingredient-dialog";
import { IngredientBasicInfo } from "./ingredient-basic-info";
import { IngredientForm } from "./ingredient-form";
import { IngredientRecipeUsagesTable } from "./ingredient-recipe-usages-table";

interface IngredientDetailProps {
  ingredient: IngredientWithFoodOut;
}

export const IngredientDetail: FC<IngredientDetailProps> = ({ ingredient }) => {
  const api = useTRPC();
  const [isEnriching, setIsEnriching] = useState(false);

  const { commonSections, editMode, mappings } = useEntityDetail<
    IngredientWithFoodOut,
    IngredientUpdateInput
  >({
    entity: "ingredient",
    data: ingredient,
    mutationOptions: api.ingredient.update.mutationOptions(),
    getMappings: getIngredientMappings,
  });

  // Find nutrition info from any product
  const nutritionInfo = ingredient.product.find((p) => p.food?.nutritionInfo)
    ?.food?.nutritionInfo;

  const sections: DetailSection[] = [
    {
      title: "Basic Information",
      icon: Info,
      content: editMode.isEditing ? (
        <IngredientForm
          mode="edit"
          entity={ingredient}
          isPending={editMode.isPending}
          error={editMode.error}
          onEdit={editMode.handleEdit}
          onCancel={editMode.handleCancel}
        />
      ) : (
        <IngredientBasicInfo
          ingredient={ingredient}
          onEdit={editMode.startEditing}
        />
      ),
    },
    // Custom section: Nutrition (only if available)
    ...(nutritionInfo
      ? [
          {
            title: "Nutrition Information",
            icon: Apple,
            content: (
              <MutedBox>
                <NutritionInfoTable n={nutritionInfo} />
              </MutedBox>
            ),
          },
        ]
      : []),
    // Custom section: Related Products
    {
      title: "Related Products",
      icon: ShoppingCart,
      content: (
        <div className="space-y-2">
          {ingredient.product.length > 0 ? (
            <EntityPillLinkList entity="product" items={ingredient.product} />
          ) : (
            <p className="text-muted-foreground text-sm">
              No products linked yet — enrich this ingredient to add pricing and
              nutrition.
            </p>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIsEnriching(true)}
          >
            <Sparkles className="h-4 w-4" />
            Enrich
          </Button>
        </div>
      ),
    },
    // Custom section: Unit Mappings — conversion capabilities + Convert modal
    // above the source-attributed table (table shows which product/food each
    // mapping came from, since ingredient mappings aggregate across products).
    {
      title: "Unit Mappings",
      icon: Scale,
      content: (
        <div className="space-y-2">
          <ConversionCapabilities mappings={mappings} />
          <UnitMappingsTable mappings={mappings} />
        </div>
      ),
    },
    // Custom section: Appears In Recipes — one row per usage, with amount,
    // source line, and a read-only parser-drift flag. Full-width so the 5-column
    // table has room (esp. the source line).
    {
      title: "Appears In Recipes",
      icon: ChefHat,
      fullWidth: true,
      content:
        ingredient.recipeUsages.length > 0 ? (
          <IngredientRecipeUsagesTable
            usages={ingredient.recipeUsages}
            ingredientName={ingredient.name}
            aliases={ingredient.aliases}
          />
        ) : (
          <p className="text-muted-foreground text-sm">
            Not used in any recipes yet.
          </p>
        ),
    },
    // Common sections from entity config (History)
    ...commonSections,
  ];

  return (
    <>
      <DetailPage
        sections={sections}
        entity="ingredient"
        name={ingredient.name}
        rawData={ingredient}
      />
      <EnrichIngredientDialog
        ingredient={
          isEnriching ? { id: ingredient.id, name: ingredient.name } : null
        }
        onOpenChange={(open) => {
          if (!open) setIsEnriching(false);
        }}
      />
    </>
  );
};
