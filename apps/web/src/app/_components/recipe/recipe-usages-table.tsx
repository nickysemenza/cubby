import type { RecipeUsage } from "@cubby/schemas/combo";
import { AlertCircle } from "lucide-react";
import { useMemo } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { computeParseDrift, type ParseDrift } from "~/lib/parse-drift";
import { wasm } from "~/lib/wasm";
import { EntityPillLink } from "../EntityPill";
import { formatAmounts } from "../inventory/format-amount";
import { DriftIndicator } from "../parse-drift-indicator";

type UsageRow = RecipeUsage & {
  // Re-parsing the stored raw line with the *current* parser, compared field-by-field
  // against what's persisted. Non-null fields are stale and would change on re-parse.
  drift: ParseDrift;
};

/**
 * Per-usage table for the "Appears In Recipes" section on the ingredient and
 * product detail pages. One row per {@link RecipeUsage} (a recipe repeats when it
 * uses the ingredient in multiple sections), showing the formatted amount,
 * modifier, and the original imported line. Re-parses each raw line with the
 * current parser and surfaces (read-only) any drift — name (Source line), amounts
 * (Amount), or modifier — via {@link computeParseDrift}. `ingredientName`/`aliases`
 * are the name(s) the drift check matches against; for products this is the
 * product's linked ingredient.
 */
export function RecipeUsagesTable({
  usages,
  ingredientName,
  aliases,
}: {
  usages: RecipeUsage[];
  ingredientName: string;
  aliases?: string[];
}) {
  const rows = useMemo<UsageRow[]>(() => {
    const knownNames = [ingredientName, ...(aliases ?? [])];
    return usages
      .map((usage) => {
        let drift: ParseDrift = { name: null, amounts: null, modifier: null };
        if (usage.rawLine) {
          const fresh = wasm.parse_ingredient(usage.rawLine);
          drift = computeParseDrift(
            {
              knownNames,
              amounts: usage.amounts,
              modifier: usage.modifier ?? null,
            },
            fresh,
          );
        }
        return { ...usage, drift };
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
              {row.drift.amounts !== null ? (
                <DriftIndicator
                  axis="amount"
                  before={formatAmounts(row.amounts)}
                  after={formatAmounts(row.drift.amounts)}
                  className="max-w-[12rem]"
                />
              ) : row.amounts.length > 0 ? (
                formatAmounts(row.amounts)
              ) : (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span className="inline-flex items-center gap-1 text-warning" />
                    }
                  >
                    <AlertCircle className="h-3 w-3 shrink-0 text-warning" />—
                  </TooltipTrigger>
                  <TooltipContent>No parsed amount</TooltipContent>
                </Tooltip>
              )}
            </td>
            <td className="py-1 pr-2 align-top text-muted-foreground">
              {row.drift.modifier !== null ? (
                <DriftIndicator
                  axis="modifier"
                  before={row.modifier ?? ""}
                  after={row.drift.modifier}
                  className="max-w-[18rem]"
                />
              ) : (
                (row.modifier ?? "")
              )}
            </td>
            <td className="py-1 align-top">
              {row.rawLine ? (
                <span className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                  <span className="text-muted-foreground/70">
                    {row.rawLine}
                  </span>
                  {row.drift.name !== null && (
                    <DriftIndicator
                      axis="name"
                      before={ingredientName}
                      after={row.drift.name}
                    />
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
