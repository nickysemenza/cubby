import { Link } from "@tanstack/react-router";
import { useMemo } from "react";

import { nivoChartTheme, nivoMotion } from "~/lib/nivo-theme";
import { formatCurrency } from "~/lib/number-format";
import type { IngredientDataItem } from "~/lib/recipe-costing";
import { ChartTooltip } from "~/ui/charts/chart-tooltip";
import { ResponsiveTreeMap } from "~/ui/charts/nivo-responsive";
import { Visualization } from "~/ui/visualizations/visualization";

interface TreemapNode {
  name: string;
  /** The ingredient's public id — null for a sub-recipe row (nothing to link). */
  ingredientId: string | null;
  // Unique identity per rendered cell: the recipeSectionIngredient row id.
  // `ingredientId` is NOT unique here — the same
  // ingredient can legitimately appear in multiple sections (or twice in one),
  // so keying cells by it produced React "duplicate key" warnings. The public
  // id is kept for the ingredient link; `rowKey` is the stable per-row key.
  rowKey: string;
  value: number; // Cost in dollars
  percentage: number;
  hasPrice: boolean;
  children?: TreemapNode[];
}

interface RecipeCostTreemapProps {
  ingredients: IngredientDataItem[];
  totalCost: number;
}

export default function RecipeCostTreemap({
  ingredients,
  totalCost,
}: RecipeCostTreemapProps) {
  const treemapData = useMemo(() => {
    const pricedItems: TreemapNode[] = [];
    const unpricedItems: TreemapNode[] = [];

    for (const ing of ingredients) {
      const name =
        ing.type === "ingredient"
          ? ing.ingredient.name
          : ing.type === "recipe"
            ? ing.recipe.name
            : "Unknown";

      const ingredientId = ing.type === "ingredient" ? ing.ingredient.id : null;
      // ing.id is the recipeSectionIngredient row id — unique per rendered cell.
      const rowKey = ing.id;

      const priceResult = ing.priceInfo?.price;
      if (priceResult?.isOk() && priceResult.value.value > 0) {
        const cost = priceResult.value.value;
        pricedItems.push({
          name,
          ingredientId,
          rowKey,
          value: cost,
          percentage: totalCost > 0 ? (cost / totalCost) * 100 : 0,
          hasPrice: true,
        });
      } else {
        unpricedItems.push({
          name,
          ingredientId,
          rowKey,
          value: 0,
          percentage: 0,
          hasPrice: false,
        });
      }
    }

    pricedItems.sort((a, b) => b.value - a.value);

    return {
      name: "Recipe Cost",
      value: 0,
      ingredientId: null,
      rowKey: "recipe-cost",
      percentage: 100,
      hasPrice: true,
      children: [...pricedItems, ...unpricedItems],
    };
  }, [ingredients, totalCost]);

  if (
    treemapData.children?.length === 0 ||
    treemapData.children?.every((c) => !c.hasPrice)
  ) {
    return (
      <Visualization
        state={{ status: "empty" }}
        message="No cost data available"
        subMessage="Add pricing to ingredients to see cost breakdown"
        height={300}
      />
    );
  }

  return <Treemap data={treemapData} />;
}

function Treemap({ data }: { data: TreemapNode }) {
  const pricedData = useMemo(
    () => ({
      ...data,
      children: data.children?.filter((node) => node.hasPrice),
    }),
    [data],
  );
  return (
    <div>
      <div style={{ height: 300 }}>
        <ResponsiveTreeMap
          data={pricedData}
          identity="rowKey"
          value="value"
          leavesOnly
          innerPadding={2}
          outerPadding={4}
          label={(node) => node.data.name}
          labelSkipSize={36}
          labelTextColor="var(--background)"
          colors={() => "var(--chart-seq-5)"}
          // Nivo's default 0.33 opacity washes out the surface behind light labels.
          nodeOpacity={1}
          borderWidth={1}
          borderColor="var(--border)"
          theme={nivoChartTheme}
          {...nivoMotion}
          tooltip={({ node }) => (
            <ChartTooltip>
              {node.data.name}: {formatCurrency(node.value)} (
              {node.data.percentage.toFixed(1)}%)
            </ChartTooltip>
          )}

          ariaLabel="Recipe cost by ingredient. Unpriced ingredients are listed separately and excluded from tile areas."
        />
      </div>
      <details className="border-t border-border p-2 text-xs">
        <summary className="cursor-pointer">Ingredient costs and links</summary>
        <ul className="max-h-64 overflow-auto py-2">
          {data.children?.map((node) => (
            <li
              key={node.rowKey}
              className="flex min-h-11 items-center justify-between gap-2 sm:min-h-0"
            >
              {node.ingredientId ? (
                <Link
                  to="/ingredients/$shortcode"
                  params={{ shortcode: node.ingredientId }}
                  className="text-primary hover:underline"
                >
                  {node.name}
                </Link>
              ) : (
                <span>{node.name}</span>
              )}
              <span className="font-mono">
                {node.hasPrice ? formatCurrency(node.value) : "Unpriced"}
              </span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
