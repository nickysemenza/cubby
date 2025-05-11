"use client";

import { type RecipeOut } from "~/schemas/recipe";
import { getGlobalInstructionNumber, getIngredientName } from "./recipeutils";
import { useWasm } from "~/hooks/useWasm";
export const NYTView: React.FC<{
  recipe: RecipeOut;
}> = ({ recipe }) => {
  const w = useWasm();
  return (
    <div className="container mx-auto">
      <div className="flex flex-col pt-2 md:flex-row">
        <div className="md:w-5/12">
          <hr className="border-t-4 border-black" />
          <div className="text-m justify-end font-serif font-bold text-black uppercase">
            Ingredients
          </div>
          {recipe.sections.map((section) =>
            section.ingredients.map((i) => (
              <div key={i.id} className="flex flex-row justify-center py-1">
                <div className="flex w-1/2 justify-end pr-1 font-light text-gray-600">
                  {i.amounts
                    .filter(
                      (a) => !["money", "calories"].includes(w.measure_kind(a)),
                    )
                    .map((a) => w.format_amount(a))
                    .join(" / ")}
                </div>
                <div className="w-1/2">{getIngredientName(i)}</div>
              </div>
            )),
          )}
        </div>
        <div className="pl-8 md:w-9/12">
          <hr className="border-t-4 border-black" />
          <div className="text-m font-serif font-bold text-black uppercase">
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
    </div>
  );
};
