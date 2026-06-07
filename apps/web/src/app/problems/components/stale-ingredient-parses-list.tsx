import type { StaleIngredientParse } from "~/server/repo/problems";
import { ProblemSection } from "./problem-section";

export function StaleIngredientParsesList({
  items,
}: {
  items: StaleIngredientParse[];
}) {
  return (
    <ProblemSection
      title="Stale Parses"
      description="Ingredient lines whose original text, re-parsed with the current parser, would now yield a different name than what's stored — re-parsing would update them."
      entity="recipe"
      items={items}
      emptyMessage="No stale parses — every stored ingredient matches a fresh parse of its original line."
      renderItem={(item) => ({
        title: `${item.storedName} → ${item.parsedName}`,
        subtitle: item.recipeName,
        details: [
          <div
            key="rawLine"
            className="text-muted-foreground/70 text-xs italic"
            title="Original line from the source"
          >
            parsed from: {item.rawLine}
          </div>,
        ],
        route: {
          to: "/recipes/$id" as const,
          params: { id: item.recipeId },
        },
      })}
    />
  );
}
