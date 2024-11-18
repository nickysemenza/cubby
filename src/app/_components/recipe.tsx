"use client";

import { api } from "~/trpc/react";
// import JsonRenderer from "./json";

export function RecipeList() {
  const [recipes] = api.recipe.list.useSuspenseQuery();

  return (
    <div>
      {recipes.map((recipe) => (
        <div key={recipe.id} className="border">
          <h2>{recipe.name}</h2>
          <ul className="list-inside list-disc">
            {recipe.sections.map((section) => (
              <li key={section.id}>
                {section.name}
                <ul className="ml-4 list-inside list-disc">
                  {section.ingredients.map((ingredient) => (
                    <li key={ingredient.id}>{ingredient.ingredient?.name}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          {/* <JsonRenderer input={recipe.sections} /> */}
        </div>
      ))}
    </div>
  );
}
