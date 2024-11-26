"use client";

import { RecipeOut } from "~/server/api/apiSchema";
import { getGlobalInstructionNumber, getIngredientName } from "./utils";
import { format_amount } from "recipebridge/pkg/recipebridge";
export const NYTView: React.FC<{
  recipe: RecipeOut;
}> = ({ recipe }) => {
  return (
    <div className="flex w-full flex-col pt-2 md:flex-row">
      <div className="md:w-5/12">
        <div className="text-m font-serif font-bold uppercase text-black">
          Ingredients
        </div>
        {recipe.sections.map((section) =>
          section.ingredients.map((i) => (
            <div key={i.id} className="flex flex-row justify-center py-1">
              <div className="flex w-1/2 justify-end pr-1 font-light text-gray-600">
                {i.amounts
                  .filter((a) => a.unit !== "$" && a.unit !== "kcal")
                  .map((a) => format_amount(a))
                  .join(" / ")}
              </div>
              <div className="w-1/2">{getIngredientName(i)}</div>
            </div>
          )),
        )}
      </div>
      <div className="md:w-9/12">
        <div className="text-m font-serif font-bold uppercase text-black">
          Instructions
        </div>
        {recipe.sections.map((section, x) =>
          section.instructions.map((i, y) => (
            <div key={y} className="py-2">
              <div className="text-l font-bold">
                Step {getGlobalInstructionNumber(recipe, x, y)}
              </div>
              {i.instruction}
            </div>
          )),
        )}
      </div>
    </div>
  );
};
