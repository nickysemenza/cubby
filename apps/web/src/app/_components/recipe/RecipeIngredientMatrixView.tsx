import { memo, useMemo } from "react";
import { cn } from "~/lib/utils";
import { dottedEntityLink, EntityPreviewLink } from "../EntityPreviewLink";
import {
  buildIngredientMatrix,
  flattenComponents,
  type RecipeTreeNode,
} from "./recipe-tree";
import { formatMakes, formatYield, gramText } from "./recipe-utils";

// Ingredient × component grid: rows are ingredients, columns are each
// sub-recipe + the root assembly at FULL BATCH, cells are how much of that
// ingredient the component's batch needs, and the Total column is the full-batch
// shopping total. The ingredient column sticks while the component columns
// scroll horizontally (wide trees).

const cellMono = "px-2 py-1.5 text-right font-mono text-xs tabular-nums";

// memo: skip re-renders from RecipeDetail's streaming churn (`tree` is stable).
export const RecipeIngredientMatrixView = memo(
  function RecipeIngredientMatrixView({ tree }: { tree: RecipeTreeNode }) {
    const recipe = tree.recipe;
    // Memoized so RecipeDetail's streaming re-renders don't re-walk the tree.
    const { components, rows, columnTotals, grandTotal } = useMemo(() => {
      const cols = flattenComponents(tree);
      const matrix = buildIngredientMatrix(tree);
      // Per-component column total (sum of its direct-ingredient cells).
      const colTotals = new Map<string, number>();
      for (const row of matrix) {
        for (const [recipeId, grams] of row.byComponent) {
          colTotals.set(recipeId, (colTotals.get(recipeId) ?? 0) + grams);
        }
      }
      return {
        components: cols,
        rows: matrix,
        columnTotals: colTotals,
        grandTotal: matrix.reduce((sum, r) => sum + r.total, 0),
      };
    }, [tree]);

    return (
      <div className="rounded-xl border border-[var(--border-chunky)] bg-card px-6 py-6 sm:px-8">
        <header className="mb-3 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <div>
            <h2 className="my-0 font-heading font-semibold text-2xl tracking-tight">
              {recipe.name}
            </h2>
            <span className="eyebrow">Ingredient × component</span>
          </div>
          {recipe.yield?.value ? (
            <span className="font-heading text-primary text-sm">
              Yields {formatYield(recipe.yield)}
            </span>
          ) : null}
        </header>

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
                        <div className="font-normal text-[9px] text-muted-foreground/70 normal-case tracking-normal">
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
                    className="sticky left-0 z-10 bg-card px-2 py-1.5 text-left font-medium text-sm"
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
                      ? gramText(columnTotals.get(node.recipe.id) as number)
                      : "·"}
                  </td>
                ))}
                <td className={cn(cellMono, "text-primary")}>
                  {gramText(grandTotal)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    );
  },
);
