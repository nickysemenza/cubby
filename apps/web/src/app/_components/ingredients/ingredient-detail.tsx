"use client";

import { type FC } from "react";
import { type DetailSection, DetailPage } from "../data-table/detail-page";
import { type IngredientWithFoodOut } from "~/server/services/ingredient.service";
import { ProductPillLink, RecipePillLink } from "../EntityPill";
import { NutritionInfoTable } from "../usda/nutrition";
import { EntityPillLinkList } from "../EntityPillLinkList";
import { IngredientForm } from "./ingredient-form";
import { type IngredientUpdateInput } from "~/schemas/ingredient";
import { useTRPC } from "~/trpc/react";
import { Card, CardContent } from "~/components/ui/card";
import { UnitMappingsTable } from "../units/unitmappingstable";
import { getAllUnitMappingsFromProduct } from "~/schemas/unit-mapping-utils";
import { useEntityDetail } from "../hooks/useEntityDetail";
import { IngredientBasicInfo } from "./ingredient-basic-info";

interface IngredientDetailProps {
  ingredient: IngredientWithFoodOut;
}

/** Aggregate unit mappings from all products for an ingredient */
async function getIngredientMappings(
  ingredient: IngredientWithFoodOut,
): Promise<Awaited<ReturnType<typeof getAllUnitMappingsFromProduct>>> {
  const results = await Promise.all(
    ingredient.product.map((product) => getAllUnitMappingsFromProduct(product)),
  );
  return results.flat();
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
      content: editMode.isEditing ? (
        <Card>
          <CardContent className="pt-6">
            <IngredientForm
              mode="edit"
              entity={ingredient}
              isPending={editMode.isPending}
              error={editMode.error}
              onEdit={editMode.handleEdit}
              onCancel={editMode.handleCancel}
            />
          </CardContent>
        </Card>
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
            content: (
              <div className="bg-muted rounded-md p-4">
                <NutritionInfoTable n={nutritionInfo} limit={10} />
              </div>
            ),
          },
        ]
      : []),
    // Custom section: Related Products
    {
      title: "Related Products",
      content: (
        <EntityPillLinkList
          items={ingredient.product}
          Pill={ProductPillLink}
          pillPropName="product"
        />
      ),
    },
    // Custom section: Unit Mappings (uses UnitMappingsTable, not UnitMappingDisplay)
    {
      title: "Unit Mappings",
      content: <UnitMappingsTable mappings={mappings} />,
    },
    // Custom section: Appears In Recipes
    {
      title: "Appears In Recipes",
      content: (
        <EntityPillLinkList
          items={ingredient.appearsInRecipes}
          Pill={RecipePillLink}
          pillPropName="recipe"
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
