import type { RecipeOut } from "@cubby/schemas/recipe";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Row, Stack } from "~/components/layout";
import { Description } from "~/components/ui/description";
import { cn } from "~/lib/utils";
import { wasm } from "~/lib/wasm";
import {
  readKitchenProgress,
  recipeInstructionStepKey,
  recipeInstructionStepKeys,
  recipeKitchenProgressStorageKey,
  toggleKitchenStep,
  writeKitchenProgress,
} from "./recipe-kitchen-progress";
import { formatRichText } from "./richtext";
import { SectionHeading } from "./section-heading";

interface RecipeInstructionsProps {
  recipe: RecipeOut;
  /** Recipe shortcode enables durable kitchen-mode progress in the detail view. */
  kitchenProgressKey?: string;
}

export function RecipeInstructions({
  recipe,
  kitchenProgressKey,
}: RecipeInstructionsProps) {
  // Kitchen mode: tap a step to mark it done (dim + strike) so you don't lose
  // Steps have no stable id, so key by section id + step index (matching the
  // list key), which is stable for a given recipe render.
  const [doneSteps, setDoneSteps] = useState<Set<string>>(new Set());
  const validStepKeys = useMemo(
    () => recipeInstructionStepKeys(recipe),
    [recipe],
  );
  const progressScope = useMemo(
    () =>
      kitchenProgressKey
        ? `${kitchenProgressKey}\u0000${[...validStepKeys].join("\u0000")}`
        : null,
    [kitchenProgressKey, validStepKeys],
  );
  const [hydratedScope, setHydratedScope] = useState<string | null>(null);

  // Read after hydration so server markup stays deterministic. Scope prevents
  // a route change from writing the prior recipe's state into the next recipe.
  useEffect(() => {
    if (!kitchenProgressKey || !progressScope) {
      setDoneSteps(new Set());
      setHydratedScope(null);
      return;
    }
    setDoneSteps(
      readKitchenProgress(
        recipeKitchenProgressStorageKey(kitchenProgressKey),
        validStepKeys,
      ),
    );
    setHydratedScope(progressScope);
  }, [kitchenProgressKey, progressScope, validStepKeys]);

  useEffect(() => {
    if (!kitchenProgressKey || hydratedScope !== progressScope) return;
    writeKitchenProgress(
      recipeKitchenProgressStorageKey(kitchenProgressKey),
      doneSteps,
    );
  }, [doneSteps, hydratedScope, kitchenProgressKey, progressScope]);

  const toggleStep = useCallback((key: string) => {
    setDoneSteps((prev) => toggleKitchenStep(prev, key));
  }, []);

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
            {section.instructions.map((instruction, stepIndex) => {
              const stepKey = recipeInstructionStepKey(section.id, stepIndex);
              const isDone = doneSteps.has(stepKey);
              return (
                <li key={stepKey}>
                  {/* The whole step is a large tap target (kitchen use, wet
                      hands) — a real button so keyboard/AT get it for free. */}
                  <Row
                    as="button"
                    type="button"
                    gap="md"
                    align="start"
                    onClick={() => toggleStep(stepKey)}
                    aria-pressed={isDone}
                    className="w-full cursor-pointer text-left"
                  >
                    {/* Step number - big italic serif numeral, cookbook style */}
                    <div
                      className={cn(
                        "w-8 shrink-0 text-right font-heading font-medium text-2xl text-primary italic leading-none",
                        isDone && "text-muted-foreground/50",
                      )}
                    >
                      {stepIndex + 1}
                    </div>
                    {/* Instruction text with highlighted ingredients and measurements */}
                    <p
                      className={cn(
                        "flex-1 pt-1 text-foreground leading-relaxed",
                        isDone && "text-muted-foreground line-through",
                      )}
                    >
                      {formatRichText(
                        wasm.parse_rich_text(
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
