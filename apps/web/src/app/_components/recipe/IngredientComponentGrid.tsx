import { sumBy } from "es-toolkit";
import { useMemo } from "react";

import {
  type CrossTabFooterRow,
  CrossTabTable,
} from "~/components/matrix/cross-tab-table";
import type { CrossTabColumn } from "~/components/matrix/group-columns";
import { EMPTY_MARK, totalCell } from "~/components/matrix/matrix-chrome";
import { formatCurrencyRange } from "~/lib/format-range";

import { dottedEntityLink, EntityPreviewLink } from "../EntityPreviewLink";
import {
  buildIngredientMatrix,
  flattenComponents,
  fullBatchCostByComponent,
  type RecipeTreeNode,
  recipeTreeDisplayImage,
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

const PINNED = [{ key: "total", label: "Total", className: totalCell }];

export function IngredientComponentGrid({
  tree,
  showCost = false,
}: {
  tree: RecipeTreeNode;
  showCost?: boolean;
}) {
  const {
    columns,
    rows,
    columnTotals,
    grandTotal,
    costByComponent,
    costTotal,
    costTotalUpper,
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
    const { byComponent, total, totalUpper } = fullBatchCostByComponent(tree);
    return {
      // Column key is the component's recipe id — the same key `byComponent`
      // and `columnTotals` are keyed by, so cells look up without a mapping.
      columns: cols.map((node): CrossTabColumn<RecipeTreeNode> => ({
        key: node.recipe.id,
        data: node,
      })),
      rows: matrix,
      columnTotals: colTotals,
      grandTotal: sumBy(matrix, (r) => r.total),
      costByComponent: byComponent,
      costTotal: total,
      costTotalUpper: totalUpper,
    };
  }, [tree]);

  const footer: CrossTabFooterRow[] = [
    {
      key: "subtotal",
      label: "Subtotal",
      labelTitle:
        "Total ingredient weight per component (raw inputs — differs from the yield when a batch loses water in cooking)",
      cell: (recipeId) =>
        columnTotals.has(recipeId)
          ? gramText(columnTotals.get(recipeId)!)
          : EMPTY_MARK,
      pinnedCell: () => (
        <span className="text-primary">{gramText(grandTotal)}</span>
      ),
    },
  ];
  if (showCost) {
    footer.push({
      key: "cost",
      label: "Cost",
      emphasis: "plain",
      cell: (recipeId) =>
        costByComponent.has(recipeId)
          ? formatCurrencyRange(
              costByComponent.get(recipeId)!.price,
              costByComponent.get(recipeId)!.priceUpper,
            )
          : EMPTY_MARK,
      pinnedCell: () => (
        <span className="text-primary">
          {costTotal != null
            ? formatCurrencyRange(costTotal, costTotalUpper ?? undefined)
            : EMPTY_MARK}
        </span>
      ),
    });
  }

  return (
    <CrossTabTable
      cornerLabel="Ingredient"
      columns={columns}
      rows={rows.map((row) => ({ key: row.ingredientId, data: row }))}
      pinned={PINNED}
      footer={footer}
      renderColumnHeader={({ data: node }) => {
        const makes = formatMakes(
          node.recipe.yield,
          node.costing?.totals.weight ?? null,
        );
        return (
          <>
            <div>
              <EntityPreviewLink
                displayImage={recipeTreeDisplayImage(node.recipe)}
                entity="recipe"
                id={node.recipe.id}
                className={dottedEntityLink}
              >
                {node.recipe.name}
              </EntityPreviewLink>
            </div>
            {makes && (
              <div className="text-2xs font-normal tracking-normal text-muted-foreground normal-case">
                makes {makes}
              </div>
            )}
          </>
        );
      }}
      renderRowHeader={({ data: row }) => (
        <EntityPreviewLink
          displayImage={null}
          entity="ingredient"
          id={row.ingredientShortcode}
          className={dottedEntityLink}
        >
          {row.name}
        </EntityPreviewLink>
      )}
      renderCell={({ data: row }, column) => {
        const grams = row.byComponent.get(column.key);
        return grams != null ? gramText(grams) : null;
      }}
      renderPinnedCell={({ data: row }) => (
        <>
          {gramText(row.total)}
          {row.estimated && <span className="text-warning"> ~</span>}
        </>
      )}
    />
  );
}
