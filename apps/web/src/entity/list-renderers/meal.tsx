import { formatMealCost } from "~/app/meals/meal-format";
import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { createCubbyColumnCollection } from "~/ui/data-table/table-features";
import { attachCubbyColumnMeta } from "~/ui/data-table/table-meta";

import type { ListRenderer, ListRowOf } from "../list-renderer-types";

const recipeLinks: ListRenderer<"meal"> = (helper) =>
  createCubbyColumnCollection((add) => {
    add(
      helper.accessor(
        (row) =>
          row.recipes.map((recipe) => ({
            id: recipe.recipeId,
            name: recipe.recipe.name,
          })),
        {
          id: "recipes",
          header: "Recipes",
          enableSorting: false,
          meta: attachCubbyColumnMeta<ListRowOf<"meal">>({
            className: "min-w-0 w-56 overflow-hidden",
            mobile: { slot: "meta", priority: 20 },
            entityRefs: (row) =>
              row.recipes.map((recipe) => ({
                entityKind: "recipe",
                entityId: recipe.recipeId,
              })),
          }),
          cell: (info) => (
            <EntityRefLink
              variant="list"
              entity="recipe"
              items={info.getValue()}
              compact
              maxItems={3}
              resolveImages={false}
            />
          ),
        },
      ),
    );
  });

// Cost stays unsortable on purpose: it is a read-time rollup of
// `recipe.totals x scale` summed through the estimate engine, and a SQL
// ORDER BY cannot preserve partial/pending/unavailable semantics.
const mealCost: ListRenderer<"meal"> = (helper) =>
  createCubbyColumnCollection((add) => {
    add(
      helper.accessor(
        (row) =>
          row.totals.cost.status === "complete" ||
          row.totals.cost.status === "partial"
            ? row.totals.cost.lower
            : null,
        {
          id: "cost",
          header: "Cost",
          enableSorting: false,
          meta: {
            numeric: true,
            className: "w-20",
            mobile: { slot: "trailing", priority: 10 },
          },
          cell: (info) => (
            <span className="tabular-nums">
              {formatMealCost(info.row.original.totals)}
            </span>
          ),
        },
      ),
    );
  });

export const mealListRenderers = {
  "recipe-links": recipeLinks,
  "meal-cost": mealCost,
} as const;
