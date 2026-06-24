import type { CookbookId } from "@cubby/schemas/identifiers";
import type { IngredientUsageRow } from "@cubby/schemas/ingredient-usage";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Stack } from "~/components/layout";
import { Description } from "~/components/ui/description";
import { useTRPC } from "~/trpc/react";
import { VisualizationPlaceholder } from "../visualizations/visualization-placeholder";
import { IngredientUsageChart } from "./ingredient-usage-chart";

/**
 * Per-cookbook (or all-cookbooks) ingredient usage: a histogram of the most-used
 * ingredients plus a full table of how many recipes use each.
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
    <Stack gap="lg">
      <IngredientUsageChart rows={rows} />
      {rows.length > 25 && (
        <Description size="xs">
          Chart shows the top 25 of {rows.length} ingredients; full list below.
        </Description>
      )}

      <UsageTable rows={rows} totalRecipes={totalRecipes} />
    </Stack>
  );
}

function UsageTable({
  rows,
  totalRecipes,
}: {
  rows: IngredientUsageRow[];
  totalRecipes: number;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--border-chunky)]">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="bg-muted/50 text-left text-muted-foreground">
            <th className="px-2 py-2 font-medium">Ingredient</th>
            <th className="px-2 py-2 text-right font-medium">Recipes</th>
            <th className="px-2 py-2 text-right font-medium">% of recipes</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const pct =
              totalRecipes > 0
                ? Math.round((row.recipeCount / totalRecipes) * 100)
                : 0;
            return (
              <tr key={row.ingredientId} className="border-t hover:bg-muted/30">
                <td className="px-2 py-2">
                  <Link
                    to="/ingredients/$id"
                    params={{ id: row.ingredientId }}
                    className="hover:underline"
                  >
                    {row.name}
                  </Link>
                </td>
                <td className="px-2 py-2 text-right tabular-nums">
                  {row.recipeCount}
                </td>
                <td className="px-2 py-2 text-right text-muted-foreground tabular-nums">
                  {pct}%
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
