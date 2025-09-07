"use client";

import { type FC, useState } from "react";
import { type DetailSection } from "../data-table/detail-page";
import { DetailPage } from "../data-table/detail-page";
import { type IngredientWithRecipesAndProductOut } from "~/schemas/combo";
import { ProductPillLink, RecipePillLink } from "../EntityPill";
import { NutritionInfoTable } from "../usda/nutrition";
import { NoneState } from "../NoneState";
import { EntityPillLinkList } from "../EntityPillLinkList";
import { Button } from "~/components/ui/button";
import { IngredientForm } from "./ingredient-form";
import { type IngredientUpdateInput } from "~/schemas/ingredient";
import { useTRPC } from "~/trpc/react";
import { useMutation } from "@tanstack/react-query";
import { Card, CardContent } from "~/components/ui/card";

interface IngredientDetailProps {
  ingredient: IngredientWithRecipesAndProductOut;
}

export const IngredientDetail: FC<IngredientDetailProps> = ({
  ingredient: initialIngredient,
}) => {
  const api = useTRPC();
  const [ingredient, setIngredient] =
    useState<IngredientWithRecipesAndProductOut>(initialIngredient);
  const [isEditing, setIsEditing] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const updateIngredient = useMutation(
    api.ingredient.update.mutationOptions({
      onSuccess: (updatedIngredient) => {
        setIngredient(updatedIngredient);
        setIsEditing(false);
      },
      onError: (error) => {
        setError(error.message);
      },
    }),
  );

  const handleEdit = (data: IngredientUpdateInput) => {
    updateIngredient.mutate(data);
  };

  const handleCancel = () => {
    setIsEditing(false);
    setError(undefined);
  };

  const sections: DetailSection[] = [
    {
      title: "Basic Information",
      content: isEditing ? (
        <Card>
          <CardContent className="pt-6">
            <IngredientForm
              mode="edit"
              entity={ingredient}
              isPending={updateIngredient.isPending}
              error={error}
              onEdit={handleEdit}
              onCancel={handleCancel}
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
            <Button
              onClick={() => setIsEditing(true)}
              variant="outline"
              size="sm"
            >
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
