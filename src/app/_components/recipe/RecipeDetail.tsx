"use client";

import React from "react";
import { SectionIngredientOut, type RecipeOut } from "~/schemas/recipe";
import { RecipeIngredientList } from "./recipeingredientlist";

const RecipeDetail: React.FC<{
  recipe: RecipeOut;
}> = ({ recipe }) => {
  const ingredients: SectionIngredientOut[] = recipe.sections.flatMap(
    (section) => section.ingredients.flatMap((i) => i),
  );
  return (
    <div>
      <h1>Recipe Detail</h1>
      {/* <JsonEditor data={recipe} /> */}
      <RecipeIngredientList ingredients={ingredients} />
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
