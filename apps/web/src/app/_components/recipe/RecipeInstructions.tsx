"use client";

import { useMemo } from "react";
import type { RecipeOut } from "~/schemas/recipe";
import { wasm } from "~/lib/wasm";
import { formatRichText } from "./richtext";

interface RecipeInstructionsProps {
  recipe: RecipeOut;
}

export function RecipeInstructions({ recipe }: RecipeInstructionsProps) {
  // Extract all ingredient names for rich text highlighting
  const ingredientNames = useMemo(() => {
    return recipe.sections.flatMap((section) =>
      section.ingredients.map((ing) =>
        ing.type === "ingredient" ? ing.ingredient.name : ing.recipe.name,
      ),
    );
  }, [recipe.sections]);

  return (
    <div className="space-y-8">
      {recipe.sections.map((section, sectionIndex) => (
        <div key={section.id} className="animate-slide-up">
          {/* Section header - only show if there are multiple sections or section has a name */}
          {(recipe.sections.length > 1 || section.name) && (
            <h3 className="mb-4 font-semibold text-xl">
              {section.name || `Part ${sectionIndex + 1}`}
            </h3>
          )}

          {/* Instructions list */}
          <ol className="my-0 ml-0 list-none space-y-4">
            {section.instructions.map((instruction, stepIndex) => (
              <li key={`${section.id}-${stepIndex}`} className="flex gap-4">
                {/* Step number */}
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary font-semibold text-primary-foreground text-sm">
                  {stepIndex + 1}
                </div>
                {/* Instruction text with highlighted ingredients and measurements */}
                <p className="flex-1 pt-1 text-foreground/90 leading-relaxed">
                  {formatRichText(
                    wasm.parse_rich_text(
                      instruction.instruction,
                      ingredientNames,
                    ),
                  )}
                </p>
              </li>
            ))}
          </ol>

          {/* No instructions message */}
          {section.instructions.length === 0 && (
            <p className="text-muted-foreground italic">
              No instructions for this section.
            </p>
          )}
        </div>
      ))}
    </div>
  );
}
