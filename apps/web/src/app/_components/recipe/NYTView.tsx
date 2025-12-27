"use client";

import { wasm } from "~/lib/wasm";
import type { RecipeOut } from "~/schemas/recipe";
import { getGlobalInstructionNumber, getIngredientName } from "./recipeutils";

export const NYTView: React.FC<{
  recipe: RecipeOut;
}> = ({ recipe }) => {
  return (
    <div className="container mx-auto">
      <div className="flex flex-col pt-2 md:flex-row">
        <div className="md:w-5/12">
          <hr className="border-black border-t-4" />
          <div className="justify-end font-bold font-serif text-black text-m uppercase">
            Ingredients
          </div>
          {recipe.sections.map((section) =>
            section.ingredients.map((i) => (
              <div key={i.id} className="flex flex-row justify-center py-1">
                <div className="flex w-1/2 justify-end pr-1 font-light text-muted-foreground">
                  {i.amounts
                    .filter(
                      (a) =>
                        !["money", "calories"].includes(wasm.amount_kind(a)),
                    )
                    .map((a) => wasm.format_amount(a))
                    .join(" / ")}
                </div>
                <div className="w-1/2">{getIngredientName(i)}</div>
              </div>
            )),
          )}
        </div>
        <div className="pl-8 md:w-9/12">
          <hr className="border-black border-t-4" />
          <div className="font-bold font-serif text-black text-m uppercase">
            Instructions
          </div>
          {recipe.sections.map((section, x) =>
            section.instructions.map((i, y) => (
              <div key={`${section.id}-${y}`} className="py-2">
                <div className="font-bold text-l">
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
