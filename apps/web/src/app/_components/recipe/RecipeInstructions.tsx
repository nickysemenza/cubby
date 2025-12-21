"use client";

import { type RecipeOut } from "~/schemas/recipe";

interface RecipeInstructionsProps {
  recipe: RecipeOut;
}

export function RecipeInstructions({ recipe }: RecipeInstructionsProps) {
  return (
    <div className="space-y-8">
      {recipe.sections.map((section, sectionIndex) => (
        <div key={section.id} className="animate-slide-up">
          {/* Section header - only show if there are multiple sections or section has a name */}
          {(recipe.sections.length > 1 || section.name) && (
            <h3 className="mb-4 text-xl font-semibold">
              {section.name || `Part ${sectionIndex + 1}`}
            </h3>
          )}

          {/* Instructions list */}
          <ol className="my-0 ml-0 list-none space-y-4">
            {section.instructions.map((instruction, stepIndex) => (
              <li key={stepIndex} className="flex gap-4">
                {/* Step number */}
                <div className="bg-primary text-primary-foreground flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold">
                  {stepIndex + 1}
                </div>
                {/* Instruction text */}
                <p className="text-foreground/90 flex-1 pt-1 leading-relaxed">
                  {instruction.instruction}
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
