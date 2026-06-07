import type { MalformedIngredientName } from "~/server/repo/problems";
import { ProblemSection } from "./problem-section";

export function MalformedIngredientNamesList({
  ingredients,
}: {
  ingredients: MalformedIngredientName[];
}) {
  return (
    <ProblemSection
      title="Malformed Ingredient Names"
      description="Ingredients whose names look like recipe-parser artifacts (a stranded adverb, a leftover unit, a bare size word). Rename or merge them into the real ingredient."
      entity="ingredient"
      items={ingredients}
      emptyMessage="No malformed ingredient names found."
      renderItem={(ingredient) => ({
        title: ingredient.name,
        subtitle: ingredient.reason,
        details: ingredient.rawLine
          ? [
              <div
                key="rawLine"
                className="text-muted-foreground/70 text-xs italic"
                title="Original line from the source"
              >
                parsed from: {ingredient.rawLine}
              </div>,
            ]
          : undefined,
        route: {
          to: "/ingredients/$id" as const,
          params: { id: ingredient.id },
        },
      })}
    />
  );
}
