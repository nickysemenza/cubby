import type { RecipeOut } from "@cubby/schemas/recipe";
import { useMemo, useState } from "react";

import { Row, Stack } from "~/components/layout";
import { Description } from "~/components/ui/description";
import { cn } from "~/lib/utils";

import { formatRichText, parseRichTextSafe } from "./richtext";
import { SectionHeading } from "./section-heading";

interface RecipeInstructionsProps {
  recipe: RecipeOut;
}

export function RecipeInstructions({ recipe }: RecipeInstructionsProps) {
  // Kitchen mode: tap a step to mark it done (dim + strike) so you don't lose
  // your place after glancing away. Local-only — no persistence needed.
  // Steps have no stable id, so key by section id + step index (matching the
  // list key), which is stable for a given recipe render.
  const [doneSteps, setDoneSteps] = useState<Set<string>>(new Set());
  const toggleStep = (key: string) => {
    setDoneSteps((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

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
          className="animate-in duration-300 fade-in slide-in-from-bottom-2"
        >
          <SectionHeading
            sectionName={section.name}
            index={sectionIndex}
            total={recipe.sections.length}
            variant="title"
          />

          <Stack as="ol" gap="sm" className="my-0 ml-0 list-none md:space-y-4">
            {section.instructions.map((instruction, stepIndex) => {
              const stepKey = `${section.id}-${stepIndex}`;
              const isDone = doneSteps.has(stepKey);
              return (
                <li key={stepKey}>
                  {/* The whole step is a large tap target (kitchen use, wet
                      hands) — a real button so keyboard/AT get it for free. */}
                  <Row
                    as="button"
                    type="button"
                    gap="sm"
                    align="start"
                    onClick={() => toggleStep(stepKey)}
                    aria-pressed={isDone}
                    className="min-h-11 w-full cursor-pointer text-left md:gap-4"
                  >
                    {/* Step number - big italic serif numeral, cookbook style */}
                    <div
                      className={cn(
                        "w-8 shrink-0 text-right font-heading text-2xl leading-none font-medium text-primary italic",
                        isDone && "text-muted-foreground/50",
                      )}
                    >
                      {stepIndex + 1}
                    </div>
                    {/* Instruction text with highlighted ingredients and measurements */}
                    <p
                      className={cn(
                        "flex-1 pt-1 leading-relaxed text-foreground",
                        isDone && "text-muted-foreground line-through",
                      )}
                    >
                      {formatRichText(
                        parseRichTextSafe(
                          instruction.instruction,
                          ingredientNames,
                        ),
                      )}
                    </p>
                  </Row>
                </li>
              );
            })}
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
