import type { RecipeOut } from "@cubby/schemas/recipe";
import { useMemo } from "react";
import { wasm } from "~/lib/wasm";
import { formatRichText } from "./richtext";
import { SectionHeading } from "./section-heading";

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
        <div
          key={section.id}
          className="fade-in slide-in-from-bottom-2 animate-in duration-300"
        >
          {/* Section header - only show if there are multiple sections or section has a name */}
          <SectionHeading
            sectionName={section.name}
            index={sectionIndex}
            total={recipe.sections.length}
            variant="title"
          />

          {/* Instructions list */}
          <ol className="my-0 ml-0 list-none space-y-4">
            {section.instructions.map((instruction, stepIndex) => (
              <li key={`${section.id}-${stepIndex}`} className="flex gap-4">
                {/* Step number - big italic serif numeral, cookbook style */}
                <div className="w-8 shrink-0 text-right font-heading font-medium text-2xl text-primary italic leading-none">
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
