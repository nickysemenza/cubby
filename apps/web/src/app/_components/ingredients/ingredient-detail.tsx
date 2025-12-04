"use client";

import { type FC } from "react";
import { useAsyncMemo } from "~/hooks/useAsyncMemo";
import { type DetailSection } from "../data-table/detail-page";
import { DetailPage } from "../data-table/detail-page";
import { type IngredientWithFoodOut } from "~/server/services/ingredient.service";
import { ProductPillLink, RecipePillLink } from "../EntityPill";
import { NutritionInfoTable } from "../usda/nutrition";
import { NoneState } from "../NoneState";
import { EntityPillLinkList } from "../EntityPillLinkList";
import { Button } from "~/components/ui/button";
import { IngredientForm } from "./ingredient-form";
import { type IngredientUpdateInput } from "~/schemas/ingredient";
import { useTRPC } from "~/trpc/react";
import { Card, CardContent } from "~/components/ui/card";
import { UnitMappingsTable } from "../units/unitmappingstable";
import { getAllUnitMappingsFromProduct } from "~/schemas/unit-mapping-utils";
import { type UnitMapping } from "~/schemas/unitmapping";
import { useEditMode } from "../hooks/useEditMode";

interface IngredientDetailProps {
  ingredient: IngredientWithFoodOut;
}

export const IngredientDetail: FC<IngredientDetailProps> = ({ ingredient }) => {
  const api = useTRPC();

  const editMode = useEditMode<IngredientUpdateInput>({
    mutationOptions: api.ingredient.update.mutationOptions(),
    useRouterRefresh: true,
  });

  // Load unit mappings asynchronously
  const unitMappings = useAsyncMemo(
    async (signal) => {
      const results: UnitMapping[][] = [];
      for (const product of ingredient.product) {
        if (signal.cancelled) return [];
        results.push(await getAllUnitMappingsFromProduct(product));
      }
      return results.flat();
    },
    [ingredient.product],
    [],
  );

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
        <div className="space-y-2">
          <div>
            <span className="font-medium">Name:</span> {ingredient.name}
          </div>
          <div>
            <span className="font-medium">Aliases:</span>{" "}
            {ingredient.aliases.length > 0 ? (
              ingredient.aliases.join(", ")
            ) : (
              <NoneState />
            )}
          </div>
          <div className="pt-2">
            <Button onClick={editMode.startEditing} variant="outline" size="sm">
              Edit Ingredient
            </Button>
          </div>
        </div>
      ),
    },
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
    {
      title: "Unit Mappings",
      content: <UnitMappingsTable mappings={unitMappings} />,
    },
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
  ];

  // Add nutrition section if any product has nutrition info
  const nutritionInfo = ingredient.product.find((p) => p.food?.nutritionInfo)
    ?.food?.nutritionInfo;
  if (nutritionInfo) {
    sections.splice(1, 0, {
      title: "Nutrition Information",
      content: (
        <div className="bg-muted rounded-md p-4">
          <NutritionInfoTable n={nutritionInfo} limit={10} />
        </div>
      ),
    });
  }

  return (
    <DetailPage
      sections={sections}
      entity="ingredient"
      name={ingredient.name}
      rawData={ingredient}
    />
  );
};
