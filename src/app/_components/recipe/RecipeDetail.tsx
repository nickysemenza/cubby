"use client";

import React, { useEffect, useMemo, useState } from "react";
import { SectionIngredientOut, type RecipeOut } from "~/schemas/recipe";
import { RecipeIngredientList } from "./recipeingredientlist";
import { IngredientWithRecipesAndProductOut } from "~/schemas/combo";
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
  const [data, dataSet] = useState<
    Record<string, IngredientWithRecipesAndProductOut> | undefined
  >(undefined);

  // Get recipe images from the recipe object
  const recipeImages = recipe.images || [];

  useEffect(() => {
    const getBulkIngredients = async (ids: string[]) => {
      const ingredientsArray: IngredientWithRecipesAndProductOut[] =
        await Promise.all(
          ids.map((id) => trpcClient.ingredient.getByID.query({ id })),
        );
      const ingredientMap: Record<string, IngredientWithRecipesAndProductOut> =
        ingredientsArray.reduce(
          (acc, ingredient) => {
            acc[ingredient.id] = ingredient;
            return acc;
          },
          {} as Record<string, IngredientWithRecipesAndProductOut>,
        );
      console.log({ somePosts: ingredientMap });
      return ingredientMap;
    };

    async function fetchMyAPI() {
      // Only get IDs from SectionIngredients that are actually ingredients (not recipes)
      const ingMap = await getBulkIngredients(
        ingredients
          .filter((i) => i.type === "ingredient")
          .map((i) => i.ingredient.id),
      );
      dataSet(ingMap);
    }

    fetchMyAPI();
  }, [ingredients, trpcClient.ingredient.getByID]);

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
