import { useMemo } from "react";
import { cn, formatCurrency } from "~/lib/utils";
import { dottedEntityLink, EntityPreviewLink } from "../EntityPreviewLink";
import {
  buildIngredientMatrix,
  flattenComponents,
  fullBatchCostByComponent,
  type RecipeTreeNode,
} from "./recipe-tree";
import { formatMakes, gramText } from "./recipe-utils";

// Ingredient × component grid: rows are ingredients, columns are each sub-recipe
// + the root assembly at FULL BATCH, cells are how much of that ingredient the
// component's batch needs, and the Total column is the full-batch shopping total.
// The ingredient column sticks while the component columns scroll horizontally.
//
// Shared by the print/export sheet (RecipeIngredientMatrixView) and the Prep
// view's "grid" sub-mode. `showCost` adds a per-component batch-cost footer row
// (the Prep view's cost atom); the export sheet leaves it off.

const cellMono = "px-2 py-2 text-right font-mono text-xs tabular-nums";

export function IngredientComponentGrid({
  tree,
  showCost = false,
}: {
  tree: RecipeTreeNode;
  showCost?: boolean;
}) {
  const {
    components,
    rows,
    columnTotals,
    grandTotal,
    costByComponent,
    costTotal,
  } = useMemo(() => {
    const cols = flattenComponents(tree);
    const matrix = buildIngredientMatrix(tree);
    // Per-component column total (sum of its direct-ingredient cells).
    const colTotals = new Map<string, number>();
    for (const row of matrix) {
      for (const [recipeId, grams] of row.byComponent) {
        colTotals.set(recipeId, (colTotals.get(recipeId) ?? 0) + grams);
      }
    }
    // Per-component direct-leaf cost (the cost atom) — sums to `total`, same
    // axis as the gram subtotal row (sub-recipe rows aren't double-counted).
    const { byComponent, total } = fullBatchCostByComponent(tree);
    return {
      components: cols,
      rows: matrix,
      columnTotals: colTotals,
      grandTotal: matrix.reduce((sum, r) => sum + r.total, 0),
      costByComponent: byComponent,
      costTotal: total,
    };
  }, [tree]);

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="eyebrow border-primary border-b-2">
            <th className="sticky left-0 z-10 bg-card px-2 py-2 font-medium">
              Ingredient
            </th>
            {components.map((node) => {
              const makes = formatMakes(
                node.recipe.yield,
                node.costing?.totals.weight ?? null,
              );
              return (
                <th
                  key={node.recipe.id}
                  className="px-2 py-2 text-right align-bottom font-medium"
                >
                  <div>
                    <EntityPreviewLink
                      entity="recipe"
                      id={node.recipe.id}
                      className={dottedEntityLink}
                    >
                      {node.recipe.name}
                    </EntityPreviewLink>
                  </div>
                  {makes && (
                    <div className="font-normal text-2xs text-muted-foreground/70 normal-case tracking-normal">
                      makes {makes}
                    </div>
                  )}
                </th>
              );
            })}
            <th className="px-2 py-2 text-right font-medium text-primary">
              Total
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.ingredientId}
              className="border-border border-b border-dashed"
            >
              <th
                scope="row"
                className="sticky left-0 z-10 bg-card px-2 py-2 text-left font-medium text-sm"
              >
                <EntityPreviewLink
                  entity="ingredient"
                  id={row.ingredientId}
                  className={dottedEntityLink}
                >
                  {row.name}
                </EntityPreviewLink>
              </th>
              {components.map((node) => {
                const grams = row.byComponent.get(node.recipe.id);
                return (
                  <td
                    key={node.recipe.id}
                    className={cn(
                      cellMono,
                      grams == null && "text-muted-foreground/30",
                    )}
                  >
                    {grams != null ? gramText(grams) : "·"}
                  </td>
                );
              })}
              <td className={cn(cellMono, "font-medium text-primary")}>
                {gramText(row.total)}
                {row.estimated && <span className="text-warning"> ~</span>}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="eyebrow border-primary border-t-2">
            <th
              className="sticky left-0 z-10 bg-card px-2 py-2 text-left font-medium"
              title="Total ingredient weight per component (raw inputs — differs from the yield when a batch loses water in cooking)"
            >
              Subtotal
            </th>
            {components.map((node) => (
              <td key={node.recipe.id} className={cellMono}>
                {columnTotals.has(node.recipe.id)
                  ? gramText(columnTotals.get(node.recipe.id)!)
                  : "·"}
              </td>
            ))}
            <td className={cn(cellMono, "text-primary")}>
              {gramText(grandTotal)}
            </td>
          </tr>
          {showCost && (
            <tr className="eyebrow">
              <th className="sticky left-0 z-10 bg-card px-2 py-2 text-left font-medium">
                Cost
              </th>
              {components.map((node) => (
                <td key={node.recipe.id} className={cellMono}>
                  {costByComponent.has(node.recipe.id)
                    ? formatCurrency(costByComponent.get(node.recipe.id)!)
                    : "·"}
                </td>
              ))}
              <td className={cn(cellMono, "text-primary")}>
                {costTotal != null ? formatCurrency(costTotal) : "·"}
              </td>
            </tr>
          )}
        </tfoot>
      </table>
    </div>
  );
}
