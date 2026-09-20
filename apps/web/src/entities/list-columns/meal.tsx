import type { MealFilters, MealOut } from "@cubby/schemas/meal";
import {
  MEAL_KIND_LABELS,
  MEAL_TYPE_LABELS,
  mealKindSchema,
  mealTypeSchema,
} from "@cubby/schemas/meal-classification";
import { useMemo } from "react";

import {
  createFilterableSelectColumn,
  createNameColumn,
  createPlainDateColumn,
} from "~/app/_components/data-table/columnHelpers";
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
import {
  mealKindBadgeVariant,
  mealKindOptions,
  mealTypeOptions,
} from "~/app/meals/meal-options";
import { Badge } from "~/components/ui/badge";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import { relationshipFieldProvenance } from "~/entities/field-provenance";
import { manifestFilterConfig } from "~/entities/filter-manifest";

import { defineListOverride } from "./types";

const columnHelper = createCubbyColumnHelper<MealOut>();

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
            data: { name: newName.trim() || null },
          });
        },
      }),
      // oxlint-disable-next-line react/exhaustive-deps -- The fresh wrapper is intentionally excluded; stable semantic members govern this hook.
      [updateMealMutation.mutateAsync],
    );
    const deletable = useDeletableConfig({
      mutationFn: entityMutationOptionsFactory("meal", "delete"),
      entityLabel: "Meal",
      entity: "meal",
    });

    const overrides = useMemo(
      () =>
        createCubbyColumnCollection<MealOut>((add) => {
          add(
            createPlainDateColumn(columnHelper, "date", {
              header: "Date",
              className: "w-32",
              mobile: { slot: "subtitle", priority: 10 },
              editable: {
                onSave: async (newDate, meal) => {
                  // A meal's date is required (never nullable): a cleared
                  // date-picker input is discarded rather than sent as null.
                  if (!newDate) return;
                  await updateMealMutation.mutateAsync({
                    id: meal.id,
                    data: { date: newDate },
                  });
                },
              },
            }),
          );
          add(
            createNameColumn(columnHelper, "meal", "name", {
              editable: nameEditable,
              className: "w-56",
              // The canonical computed title (name || date) keeps this
              // column's empty state in step with every other meal-naming
              // surface.
              emptyLabel: (row) => row.displayName,
            }),
          );
          add(
            createFilterableSelectColumn(columnHelper, "mealType", {
              header: "Type",
              placeholder: "Filter by meal type...",
              selectOptions: mealTypeOptions,
              className: "w-28",
              mobile: { slot: "meta", priority: 30 },
              filterConfig: manifestFilterConfig("meal", "mealType"),
              renderCell: (value) => {
                const mealType = mealTypeSchema.nullable().parse(value);
                return mealType ? (
                  <Badge variant="outline">{MEAL_TYPE_LABELS[mealType]}</Badge>
                ) : null;
              },
              editable: {
                parseValue: (value) => mealTypeSchema.nullable().parse(value),
                onSave: async (newValue, meal) => {
                  await updateMealMutation.mutateAsync({
                    id: meal.id,
                    data: { mealType: newValue },
                  });
                },
              },
            }),
          );
          add(
            createFilterableSelectColumn(columnHelper, "mealKind", {
              header: "Kind",
              placeholder: "Filter by kind...",
              selectOptions: mealKindOptions,
              className: "w-28",
              mobile: { slot: "meta", priority: 40 },
              filterConfig: manifestFilterConfig("meal", "mealKind"),
              renderCell: (value) => {
                const mealKind = mealKindSchema.parse(value);
                return (
                  <Badge variant={mealKindBadgeVariant[mealKind]}>
                    {MEAL_KIND_LABELS[mealKind]}
                  </Badge>
                );
              },
              editable: {
                parseValue: (value) => mealKindSchema.parse(value),
                onSave: async (newValue, meal) => {
                  await updateMealMutation.mutateAsync({
                    id: meal.id,
                    data: { mealKind: newValue },
                  });
                },
              },
            }),
          );
        }),
      // oxlint-disable-next-line react/exhaustive-deps -- updateMealMutation changes every render but is functionally stable
      [nameEditable],
    );

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
        // Same fallback the Name column uses, so the confirm dialog names an
        // unnamed meal by its date instead of its id.
        deleteEmptyLabel: mealDateLabel,
      }),
      [deletable],
    );
    return { overrides, compose, list };
  },
});
