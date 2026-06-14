import type { CookbookId } from "@cubby/schemas/identifiers";
import type { IngredientUsageRow } from "@cubby/schemas/ingredient-usage";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Merge } from "lucide-react";
import { useMemo, useState } from "react";
import { detectMergeGroups } from "~/lib/ingredient-merge-candidates";
import { cn } from "~/lib/utils";
import { useTRPC } from "~/trpc/react";
import { VisualizationPlaceholder } from "../visualizations/visualization-placeholder";
import { IngredientUsageChart } from "./ingredient-usage-chart";
import {
  type MergeCandidate,
  MergeIngredientsDialog,
} from "./merge-ingredients-dialog";

/**
 * Per-cookbook (or all-cookbooks) ingredient usage: a histogram of the most-used
 * ingredients plus a full sortable-by-count table. Near-duplicate names are
 * flagged with a "merge?" affordance wired to the ingredient merge mutation.
 */
export function IngredientUsagePanel({
  cookbookId,
}: {
  cookbookId?: CookbookId;
}) {
  const api = useTRPC();
  const { data, isLoading } = useQuery(
    api.recipe.getIngredientUsage.queryOptions({ cookbookId }),
  );
  const [mergeGroup, setMergeGroup] = useState<MergeCandidate[] | null>(null);

  // Map each ingredient id → the full merge group it belongs to (≥2 members),
  // so a row can open the dialog pre-filled with its near-duplicates.
  const groupByIngredient = useMemo(() => {
    const map = new Map<string, MergeCandidate[]>();
    if (!data) return map;
    for (const group of detectMergeGroups(data.rows)) {
      const members: MergeCandidate[] = group.members.map((m) => ({
        id: m.ingredientId,
        name: m.name,
      }));
      for (const m of members) map.set(m.id, members);
    }
    return map;
  }, [data]);

  if (isLoading) {
    return (
      <VisualizationPlaceholder
        message="Loading ingredient usage…"
        height={400}
      />
    );
  }

  if (!data || data.rows.length === 0) {
    return (
      <VisualizationPlaceholder
        message="No ingredient usage to show"
        subMessage="Add recipes with ingredients to see usage counts"
        height={400}
      />
    );
  }

  const { rows, totalRecipes } = data;

  return (
    <div className="space-y-6">
      <IngredientUsageChart rows={rows} />
      {rows.length > 25 && (
        <p className="text-muted-foreground text-xs">
          Chart shows the top 25 of {rows.length} ingredients; full list below.
        </p>
      )}

      <UsageTable
        rows={rows}
        totalRecipes={totalRecipes}
        groupByIngredient={groupByIngredient}
        onMerge={setMergeGroup}
      />

      <MergeIngredientsDialog
        open={mergeGroup !== null}
        onOpenChange={(open) => {
          if (!open) setMergeGroup(null);
        }}
        ingredients={mergeGroup ?? []}
        onMerged={() => setMergeGroup(null)}
      />
    </div>
  );
}

function UsageTable({
  rows,
  totalRecipes,
  groupByIngredient,
  onMerge,
}: {
  rows: IngredientUsageRow[];
  totalRecipes: number;
  groupByIngredient: Map<string, MergeCandidate[]>;
  onMerge: (group: MergeCandidate[]) => void;
}) {
  return (
    <div className="overflow-hidden rounded-lg border">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="bg-muted/50 text-left text-muted-foreground">
            <th className="px-3 py-2 font-medium">Ingredient</th>
            <th className="px-3 py-2 text-right font-medium">Recipes</th>
            <th className="px-3 py-2 text-right font-medium">% of recipes</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const group = groupByIngredient.get(row.ingredientId);
            const pct =
              totalRecipes > 0
                ? Math.round((row.recipeCount / totalRecipes) * 100)
                : 0;
            return (
              <tr key={row.ingredientId} className="border-t hover:bg-muted/30">
                <td className="px-3 py-2">
                  <Link
                    to="/ingredients/$id"
                    params={{ id: row.ingredientId }}
                    className="hover:underline"
                  >
                    {row.name}
                  </Link>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {row.recipeCount}
                </td>
                <td className="px-3 py-2 text-right text-muted-foreground tabular-nums">
                  {pct}%
                </td>
                <td className="px-3 py-2 text-right">
                  {group && group.length >= 2 && (
                    <button
                      type="button"
                      onClick={() => onMerge(group)}
                      className={cn(
                        "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs",
                        "bg-warning/15 text-warning hover:bg-warning/25",
                      )}
                      title={`Looks like ${group.length} variants of the same ingredient`}
                    >
                      <Merge className="h-3 w-3" />
                      merge?
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
