import type { MealFilters, MealOut } from "@cubby/schemas/meal";
import { useMemo } from "react";

import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  type CubbyColumnCollection,
} from "~/app/_components/data-table/table-features";
import { attachCubbyColumnMeta } from "~/app/_components/data-table/table-meta";
import { EntityInlineLinkList } from "~/app/_components/EntityInlineLinkList";
import { useDeletableConfig } from "~/app/_components/hooks/useDeletableConfig";
import { useUpdateMutation } from "~/app/_components/hooks/useUpdateMutation";
import { formatMealCost, mealDateLabel } from "~/app/meals/meal-format";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import { relationshipFieldProvenance } from "~/entities/field-provenance";

import { defineListOverride } from "./types";

const columnHelper = createCubbyColumnHelper<MealOut>();

export function mealNameUpdate(newName: string) {
  return { name: newName.trim() || null };
}

/**
 * The `/meals?view=table` surface: inline rename/reschedule, delete (row +
 * bulk). Cost stays unsortable on purpose: it is a read-time rollup of
 * `recipe.totals x scale` summed through the estimate engine, and a SQL
 * ORDER BY cannot preserve partial/pending/unavailable semantics.
 */
export const mealListOverride = defineListOverride<MealOut, MealFilters>({
  use() {
    const updateMealMutation = useUpdateMutation({
      mutationFn: entityMutationOptionsFactory("meal", "update"),
      entity: "meal",
    });
    // NOT `useNameEditable` — it hardcodes `{ name: newName }`, which would
    // persist `""` on a cleared name and defeat the date fallback (an empty
    // edit must write `null`).
    const nameEditable = useMemo(
      () => ({
        onSave: async (newName: string, meal: MealOut) => {
          await updateMealMutation.mutateAsync({
            id: meal.id,
            data: mealNameUpdate(newName),
          });
        },
        getValue: (meal: MealOut) => meal.name,
      }),
      // oxlint-disable-next-line react/exhaustive-deps -- The fresh wrapper is intentionally excluded; stable semantic members govern this hook.
      [updateMealMutation.mutateAsync],
    );
    const deletable = useDeletableConfig({
      mutationFn: entityMutationOptionsFactory("meal", "delete"),
      entityLabel: "Meal",
      entity: "meal",
    });

    const compose = useMemo(
      () => (declared: CubbyColumnCollection<MealOut>) =>
        createCubbyColumnCollection<MealOut>((add) => {
          declared.visit(add);
          add(
            columnHelper.accessor(
              (row) =>
                row.recipes.map((r) => ({
                  id: r.recipeId,
                  name: r.recipe.name,
                })),
              {
                id: "recipes",
                header: "Recipes",
                enableSorting: false,
                meta: attachCubbyColumnMeta<MealOut>({
                  provenance: relationshipFieldProvenance("meal", "recipes"),
                  explanation: {
                    entity: "meal",
                    field: "recipes",
                    label: "Recipes",
                  },
                  className: "min-w-0 w-56 overflow-hidden",
                  mobile: { slot: "meta", priority: 20 },
                  entityRefs: (row) =>
                    row.recipes.map((recipe) => ({
                      entityType: "recipe",
                      entityId: recipe.recipeId,
                    })),
                }),
                cell: (info) => (
                  <EntityInlineLinkList
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
          add(
            columnHelper.accessor(
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
                  provenance: relationshipFieldProvenance("meal", "recipes"),
                  explanation: {
                    entity: "meal",
                    field: "costTotal",
                    label: "Cost",
                  },
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
        }),
      [],
    );

    const list = useMemo(
      () => ({
        deletable,
        nameClassName: "w-56",
        nameEditable,
        // Same fallback the Name column uses, so the confirm dialog names an
        // unnamed meal by its date instead of its id.
        deleteEmptyLabel: mealDateLabel,
      }),
      [deletable, nameEditable],
    );
    return { compose, list };
  },
});
