import type { CookbookShortcode } from "@cubby/schemas/identifiers";
import type { IngredientUsageRow } from "@cubby/schemas/ingredient-usage";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { recipe } from "~/integrations/tanstack-query/generated/catalog.gen";
import { getAppErrorDetails } from "~/lib/error-utils";
import { Stack } from "~/ui/layout";
import { Description } from "~/ui/primitives/description";
import { StaticTable } from "~/ui/primitives/static-table";

import { VisualizationPlaceholder } from "../../ui/visualizations/visualization-placeholder";
import { IngredientUsageChart } from "./ingredient-usage-chart";

/**
 * Per-cookbook (or all-cookbooks) ingredient usage: a histogram of the most-used
 * ingredients plus a full table of how many recipes use each.
 *
 * With `limit` set (the homepage panel), the table is dropped entirely — its top
 * rows would duplicate the histogram's ranking — and the chart is capped to
 * `limit` bars with a "view all" footer link instead.
 */
export function IngredientUsagePanel({
  cookbookId,
  limit,
}: {
  cookbookId?: CookbookShortcode;
  /** Compact mode: cap the chart to `limit` bars, skip the table. */
  limit?: number;
}) {
  const { data, isError, error, isLoading, refetch } = useQuery(
    recipe.getIngredientUsage.queryOptions({ cookbookId }),
  );

  if (isLoading) {
    return (
      <VisualizationPlaceholder
        message="Loading ingredient usage…"
        height={400}
      />
    );
  }

  if (isError) {
    return (
      <VisualizationPlaceholder
        message="Ingredient usage is unavailable"
        subMessage={getAppErrorDetails(error).message}
        height={400}
        onRetry={() => void refetch()}
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

  if (limit != null) {
    const topIngredients = [...rows]
      .sort((a, b) => b.recipeCount - a.recipeCount)
      .slice(0, Math.min(limit, 3));

    return (
      <Stack gap="sm">
        <IngredientUsageChart rows={rows} maxBars={limit} />
        <nav
          aria-label="Top recipe ingredients"
          className="flex flex-wrap gap-1 border border-[var(--border)] p-1"
        >
          {topIngredients.map((row) => (
            <Link
              key={row.ingredientId}
              to="/ingredients/$shortcode"
              params={{ shortcode: row.ingredientId }}
              className="inline-flex min-h-11 items-center px-2 text-xs text-primary hover:underline sm:min-h-0"
            >
              {row.name} ({row.recipeCount})
            </Link>
          ))}
        </nav>
        {rows.length > limit && (
          <Link
            to="/ingredients"
            className="inline-flex min-h-11 items-center text-xs text-primary hover:underline sm:min-h-0"
          >
            View all {rows.length} ingredients →
          </Link>
        )}
      </Stack>
    );
  }

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
    <StaticTable
      rows={rows}
      rowKey={(row) => row.ingredientId}
      containerClassName="border border-[var(--border)]"
      className="min-w-[26rem] table-auto"
      columns={[
        {
          id: "ingredient",
          header: "Ingredient",
          cellClassName: "whitespace-normal",
          cell: (row) => (
            <Link
              to="/ingredients/$shortcode"
              params={{ shortcode: row.ingredientId }}
              className="hover:underline"
            >
              {row.name}
            </Link>
          ),
        },
        {
          id: "recipes",
          header: "Recipes",
          headClassName: "text-right",
          cellClassName: "text-right tabular-nums",
          cell: (row) => row.recipeCount,
        },
        {
          id: "share",
          header: "% of recipes",
          headClassName: "text-right",
          cellClassName: "text-right text-muted-foreground tabular-nums",
          cell: (row) =>
            `${totalRecipes > 0 ? Math.round((row.recipeCount / totalRecipes) * 100) : 0}%`,
        },
      ]}
    />
  );
}
