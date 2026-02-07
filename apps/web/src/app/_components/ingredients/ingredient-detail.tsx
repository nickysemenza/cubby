import type { IngredientUpdateInput } from "@cubby/schemas/ingredient";
import { Apple, ChefHat, Info, Scale, ShoppingCart } from "lucide-react";
import type { FC } from "react";
import { MutedBox } from "~/components/layout/muted-box";
import { getIngredientMappings } from "~/lib/unit-mapping-utils";
import type { IngredientWithFoodOut } from "~/server/services/ingredient.service";
import { useTRPC } from "~/trpc/react";
import { DetailPage, type DetailSection } from "../data-table/detail-page";
import { EntityPillLinkList } from "../EntityPillLinkList";
import { useEntityDetail } from "../hooks/useEntityDetail";
import { UnitMappingsTable } from "../units/unitmappingstable";
import { NutritionInfoTable } from "../usda/nutrition";
import { IngredientBasicInfo } from "./ingredient-basic-info";
import { IngredientForm } from "./ingredient-form";

interface IngredientDetailProps {
  ingredient: IngredientWithFoodOut;
}

export const IngredientDetail: FC<IngredientDetailProps> = ({ ingredient }) => {
  const api = useTRPC();

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
        <EntityPillLinkList entity="product" items={ingredient.product} />
      ),
    },
    // Custom section: Unit Mappings (uses UnitMappingsTable, not UnitMappingDisplay)
    {
      title: "Unit Mappings",
      icon: Scale,
      content: <UnitMappingsTable mappings={mappings} />,
    },
    // Custom section: Appears In Recipes
    {
      title: "Appears In Recipes",
      icon: ChefHat,
      content: (
        <EntityPillLinkList
          entity="recipe"
          items={ingredient.appearsInRecipes}
        />
      ),
    },
    // Common sections from entity config (History)
    ...commonSections,
  ];

  return (
    <DetailPage
      sections={sections}
      entity="ingredient"
      name={ingredient.name}
      rawData={ingredient}
    />
  );
};
