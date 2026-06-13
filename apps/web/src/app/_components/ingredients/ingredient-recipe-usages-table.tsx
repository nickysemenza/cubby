import type { RecipeUsage } from "@cubby/schemas/combo";
import { AlertCircle } from "lucide-react";
import { useMemo } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { wasm } from "~/lib/wasm";
import { EntityPillLink } from "../EntityPill";
import { formatAmounts } from "../inventory/format-amount";

const norm = (s: string) => s.trim().toLowerCase();

type UsageRow = RecipeUsage & {
  // Re-parsing the stored raw line with the *current* parser yields a different
  // ingredient name than this ingredient answers to (its name or any alias) —
  // i.e. the stored parse has drifted. null when there's no raw line to check.
  driftedTo: string | null;
};

/**
 * Per-usage table for the ingredient detail page's "Appears In Recipes" section.
 * One row per {@link RecipeUsage} (a recipe repeats when it uses the ingredient in
 * multiple sections), showing the formatted amount, modifier, and the original
 * imported line. Mirrors {@link IngredientReparse}'s drift check — re-parses each
 * raw line and flags (read-only) when it would now resolve to a different name.
 */
export function IngredientRecipeUsagesTable({
  usages,
  ingredientName,
  aliases,
}: {
  usages: RecipeUsage[];
  ingredientName: string;
  aliases?: string[];
}) {
  const rows = useMemo<UsageRow[]>(() => {
    const known = new Set([ingredientName, ...(aliases ?? [])].map(norm));
    return usages
      .map((usage) => {
        let driftedTo: string | null = null;
        if (usage.rawLine) {
          const fresh = wasm.parse_ingredient(usage.rawLine);
          if (!known.has(norm(fresh.name))) driftedTo = fresh.name;
        }
        return { ...usage, driftedTo };
      })
      .sort(
        (a, b) =>
          a.recipe.name.localeCompare(b.recipe.name) ||
          (a.sectionName ?? "").localeCompare(b.sectionName ?? ""),
      );
  }, [usages, ingredientName, aliases]);

  if (rows.length === 0) return null;

  return (
    <table className="w-full border-collapse text-xs">
      <thead>
        <tr className="border-border/40 border-b text-left text-muted-foreground">
          <th className="py-1 pr-2 font-medium">Recipe</th>
          <th className="py-1 pr-2 font-medium">Section</th>
          <th className="py-1 pr-2 font-medium">Amount</th>
          <th className="py-1 pr-2 font-medium">Modifier</th>
          <th className="py-1 font-medium">Source line</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id} className="border-border/40 border-b last:border-0">
            <td className="py-1 pr-2 align-top">
              <EntityPillLink entity="recipe" data={row.recipe} />
            </td>
            <td className="py-1 pr-2 align-top text-muted-foreground">
              {row.sectionName ?? ""}
            </td>
            <td className="whitespace-nowrap py-1 pr-2 align-top text-muted-foreground">
              {row.amounts.length > 0 ? (
                formatAmounts(row.amounts)
              ) : (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span className="inline-flex items-center gap-1 text-amber-700" />
                    }
                  >
                    <AlertCircle className="h-3 w-3 shrink-0 text-amber-600" />—
                  </TooltipTrigger>
                  <TooltipContent>No parsed amount</TooltipContent>
                </Tooltip>
              )}
            </td>
            <td className="py-1 pr-2 align-top text-muted-foreground">
              {row.modifier ?? ""}
            </td>
            <td className="py-1 align-top">
              {row.rawLine ? (
                <span className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                  <span className="text-muted-foreground/70">
                    {row.rawLine}
                  </span>
                  {row.driftedTo && (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <span className="inline-flex items-center gap-0.5 whitespace-nowrap text-amber-700" />
                        }
                      >
                        <AlertCircle className="h-3 w-3 shrink-0 text-amber-600" />
                        → {row.driftedTo}
                      </TooltipTrigger>
                      <TooltipContent>
                        Now parses as "{row.driftedTo}" — open the recipe to
                        re-parse.
                      </TooltipContent>
                    </Tooltip>
                  )}
                </span>
              ) : (
                <span
                  className="text-muted-foreground/50 italic"
                  title="No source line captured for this usage"
                >
                  (no source line)
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
