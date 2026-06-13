import { formatAmounts } from "~/app/_components/inventory/format-amount";
import { DriftIndicator } from "~/app/_components/parse-drift-indicator";
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
      description="Ingredient lines whose original text, re-parsed with the current parser, would now differ from what's stored — on name, amounts, or modifier. Re-parsing would update them."
      entity="recipe"
      items={items}
      emptyMessage="No stale parses — every stored ingredient matches a fresh parse of its original line."
      renderItem={(item) => ({
        // Title is the stable ingredient name; every drifted axis (name included) is a
        // DriftIndicator in the details — the card title is string-typed, so a colored
        // diff can't live there.
        title: item.storedName,
        subtitle: item.recipeName,
        details: [
          item.nameDrift ? (
            <div key="name" className="flex items-baseline gap-1 text-xs">
              <DriftIndicator
                before={item.storedName}
                after={item.parsedName}
              />
            </div>
          ) : null,
          item.amountDrift ? (
            <div key="amounts" className="flex items-baseline gap-1 text-xs">
              <DriftIndicator
                before={formatAmounts(item.storedAmounts)}
                after={formatAmounts(item.parsedAmounts)}
              />
            </div>
          ) : null,
          item.modifierDrift ? (
            <div
              key="modifier"
              className="flex items-baseline gap-1 text-muted-foreground/60 text-xs"
            >
              mod:{" "}
              <DriftIndicator
                tone="muted"
                before={item.storedModifier ?? ""}
                after={item.parsedModifier ?? ""}
              />
            </div>
          ) : null,
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
