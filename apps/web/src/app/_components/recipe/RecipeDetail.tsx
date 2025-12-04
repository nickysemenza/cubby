"use client";

import React, { useMemo } from "react";
import { useAsyncMemo } from "~/hooks/useAsyncMemo";
import { SectionIngredientOut, type RecipeOut } from "~/schemas/recipe";
import { RecipeIngredientList } from "./recipeingredientlist";
import { type IngredientWithFoodOut } from "~/server/services/ingredient.service";
import EntityImageList from "../EntityImageList";
import { useTRPCClient } from "~/trpc/react";

const RecipeDetail: React.FC<{
  recipe: RecipeOut;
}> = ({ recipe }) => {
  const trpcClient = useTRPCClient();

  const ingredients: SectionIngredientOut[] = useMemo(
    () =>
      recipe.sections.flatMap((section) =>
        section.ingredients.flatMap((i) => i),
      ),
    [recipe.sections],
  );
  // Get recipe images from the recipe object
  const recipeImages = recipe.images;

  // Load ingredient data asynchronously
  const data = useAsyncMemo(
    async () => {
      const ids = ingredients
        .filter((i) => i.type === "ingredient")
        .map((i) => i.ingredient.id);

      const ingredientsArray: IngredientWithFoodOut[] = await Promise.all(
        ids.map((id) => trpcClient.ingredient.getByID.query({ id })),
      );

      return ingredientsArray.reduce(
        (acc, ingredient) => {
          acc[ingredient.id] = ingredient;
          return acc;
        },
        {} as Record<string, IngredientWithFoodOut>,
      );
    },
    [ingredients, trpcClient.ingredient.getByID],
    undefined,
  );

  return (
    <div>
      <h1>Recipe Detail</h1>

      {/* Recipe Images Section */}
      <div className="mb-6">
        <EntityImageList images={recipeImages} title="Recipe Images" />
      </div>

      <RecipeIngredientList ingredients={ingredients} ingMap={data} />
    </div>
  );
};

export default RecipeDetail;
