import type { RecipeOut } from "@cubby/schemas/recipe";
import { useMemo } from "react";
import { Row, Stack } from "~/components/layout";
import { Description } from "~/components/ui/description";
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
    <Stack gap="lg">
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
          <Stack as="ol" gap="md" className="my-0 ml-0 list-none">
            {section.instructions.map((instruction, stepIndex) => (
              <Row as="li" gap="md" key={`${section.id}-${stepIndex}`}>
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
              </Row>
            ))}
          </Stack>

          {/* No instructions message */}
          {section.instructions.length === 0 && (
            <Description className="italic">
              No instructions for this section.
            </Description>
          )}
        </div>
      ))}
    </Stack>
  );
}
