"use client";

import React, { useEffect, useMemo, useState } from "react";
import { SectionIngredientOut, type RecipeOut } from "~/schemas/recipe";
import { RecipeIngredientList } from "./recipeingredientlist";
import { buildCLient } from "~/trpc/react";
import { IngredientOut } from "~/schemas/combo";

const RecipeDetail: React.FC<{
  recipe: RecipeOut;
}> = ({ recipe }) => {
  const [trpcClient] = useState(() => buildCLient());

  const ingredients: SectionIngredientOut[] = useMemo(
    () =>
      recipe.sections.flatMap((section) =>
        section.ingredients.flatMap((i) => i),
      ),
    [recipe.sections],
  );
  const [data, dataSet] = useState<Record<string, IngredientOut> | undefined>(
    undefined,
  );

  useEffect(() => {
    const getBulkIngredients = async (ids: string[]) => {
      const ingredientsArray: IngredientOut[] = await Promise.all(
        ids.map((id) => trpcClient.ingredient.getByID.query({ id })),
      );
      const ingredientMap: Record<string, IngredientOut> =
        ingredientsArray.reduce(
          (acc, ingredient) => {
            acc[ingredient.id] = ingredient;
            return acc;
          },
          {} as Record<string, IngredientOut>,
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
      {/* <JsonEditor data={recipe} /> */}
      <RecipeIngredientList ingredients={ingredients} ingMap={data} />
      {/* {ingredients.map((ingredient, index) => (
        <div key={index}>
          <h3>{ingredient.ingredient?.name}</h3>
          <JsonEditor data={ingredient} />
        </div>
      ))} */}
    </div>
  );
};

export default RecipeDetail;
