"use client";

import { type FC } from "react";
import JsonRenderer from "~/app/_components/json-renderer";
import { type DetailSection } from "../data-table/detail-page";
import { DetailPage } from "../data-table/detail-page";
import { type IngredientOut } from "~/schemas/combo";
import { ProductPillLink, RecipePillLink } from "../EntityPill";
import { NutritionInfoTable } from "../usda/nutrition";
import { NoneState } from "../NoneState";
import { EntityPillLinkList } from "../EntityPillLinkList";

interface IngredientDetailProps {
  ingredient: IngredientOut;
}

export const IngredientDetail: FC<IngredientDetailProps> = ({ ingredient }) => {
  const sections: DetailSection[] = [
    {
      title: "Basic Information",
      content: (
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
      title: "Appears In Recipes",
      content: (
        <EntityPillLinkList
          items={ingredient.appearsInRecipes}
          Pill={RecipePillLink}
          pillPropName="recipe"
        />
      ),
    },
    {
      title: "Raw Details",
      content: (
        <div className="bg-muted rounded-md p-4">
          <JsonRenderer input={ingredient} />
        </div>
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
    />
  );
};
