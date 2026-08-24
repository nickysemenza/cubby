import type { MealFilters, MealOut } from "@cubby/schemas/meal";
import {
  MEAL_KIND_LABELS,
  MEAL_TYPE_LABELS,
  type MealKind,
  type MealType,
} from "@cubby/schemas/meal-classification";
import { useMemo } from "react";
import { createCubbyColumnHelper } from "~/app/_components/data-table/table-features";
import { Badge } from "~/components/ui/badge";
import { manifestFilterConfig } from "~/entities/filter-manifest";
import { useTRPC } from "~/integrations/trpc/react";
import {
  createFilterableSelectColumn,
  createNameColumn,
  createPlainDateColumn,
} from "../_components/data-table/columnHelpers";
import { ListWorkbench } from "../_components/data-table/ListWorkbench";
import { EntityInlineLinkList } from "../_components/EntityInlineLinkList";
import { useDeletableConfig } from "../_components/hooks/useDeletableConfig";
import { useEntityList } from "../_components/hooks/useEntityList";
import { useUpdateMutation } from "../_components/hooks/useUpdateMutation";
import { formatMealCost, mealDateLabel } from "./meal-format";
import {
  mealKindBadgeVariant,
  mealKindOptions,
  mealTypeOptions,
} from "./meal-options";

/**
 * The `/meals?view=table` surface — the CRUD-complete sibling of the
 * calendar view: inline rename/reschedule, delete (row + bulk), and a
 * `/meals` header "New" action (wired in meals.index.tsx)
 * that the calendar-only "+ Meal" affordance never covered.
 *
 * Server-side list/sort/filter/paginate. This used to fetch 500 rows and sort
 * them in React because `mealSortableFields` lacked `name`, so the very first
 * click on the Name header would 400 — `createNameColumn` sets
 * `enableSorting: true` unconditionally. Adding `name` (and `mealType`, ranked
 * by slot rather than by slug) removed that blocker. Cost stays unsortable on
 * purpose: see the column below.
 */
export function MealTable() {
  const api = useTRPC();
  const columnHelper = useMemo(() => createCubbyColumnHelper<MealOut>(), []);

  const updateMealMutation = useUpdateMutation({
    mutationFn: api.meal.update.mutationOptions,
    entity: "meal",
  });

  // NOT `useNameEditable` — it hardcodes `data: { name: newName } `, which
  // would persist `""` on a cleared name and defeat the emptyLabel date
  // fallback below (an empty edit must write `null`, not "").
  const nameEditable = useMemo(
    () => ({
      onSave: async (newName: string, meal: MealOut) => {
        await updateMealMutation.mutateAsync({
          id: meal.id,
          data: { name: newName.trim() || null },
        });
      },
    }),
    [updateMealMutation.mutateAsync],
  );

  const deletableConfig = useDeletableConfig({
    mutationFn: api.meal.delete.mutationOptions,
    entityLabel: "Meal",
    entity: "meal",
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: updateMealMutation changes every render but is functionally stable
  const columns = useMemo(
    () => [
      createPlainDateColumn(columnHelper, "date", {
        header: "Date",
        className: "w-32",
        mobile: { slot: "subtitle", priority: 10 },
        editable: {
          onSave: async (newDate, meal) => {
            // A meal's date is required (mealUpdateData's `date` is
            // optional-to-omit, never nullable) — a cleared date-picker
            // input is discarded rather than sent as a null patch.
            if (!newDate) return;
            await updateMealMutation.mutateAsync({
              id: meal.id,
              data: { date: newDate },
            });
          },
        },
      }),
      createNameColumn(columnHelper, "meal", "name", {
        editable: nameEditable,
        className: "w-56",
        // Same fallback the meal detail page's title uses for an unnamed
        // meal — an unnamed meal is identified by its date.
        emptyLabel: mealDateLabel,
      }),
      createFilterableSelectColumn(columnHelper, "mealType", {
        header: "Type",
        placeholder: "Filter by meal type...",
        selectOptions: mealTypeOptions,
        className: "w-28",
        mobile: { slot: "meta", priority: 30 },
        filterConfig: manifestFilterConfig("meal", "mealType"),
        renderCell: (value) =>
          value ? (
            <Badge variant="outline">
              {MEAL_TYPE_LABELS[value as MealType]}
            </Badge>
          ) : null,
        editable: {
          onSave: async (newValue, meal) => {
            await updateMealMutation.mutateAsync({
              id: meal.id,
              data: { mealType: newValue },
            });
          },
        },
      }),
      createFilterableSelectColumn(columnHelper, "mealKind", {
        header: "Kind",
        placeholder: "Filter by kind...",
        selectOptions: mealKindOptions,
        className: "w-28",
        mobile: { slot: "meta", priority: 40 },
        filterConfig: manifestFilterConfig("meal", "mealKind"),
        renderCell: (value) => (
          <Badge variant={mealKindBadgeVariant[value as MealKind]}>
            {MEAL_KIND_LABELS[value as MealKind]}
          </Badge>
        ),
        editable: {
          onSave: async (newValue, meal) => {
            await updateMealMutation.mutateAsync({
              id: meal.id,
              data: { mealKind: newValue },
            });
          },
        },
      }),
      columnHelper.accessor(
        (row) =>
          row.recipes.map((r) => ({ id: r.recipeId, name: r.recipe.name })),
        {
          id: "recipes",
          header: "Recipes",
          enableSorting: false,
          meta: {
            className: "min-w-0 w-56 overflow-hidden",
            mobile: { slot: "meta", priority: 20 },
          },
          cell: (info) => (
            <EntityInlineLinkList
              entity="recipe"
              items={info.getValue()}
              compact
              maxItems={3}
            />
          ),
        },
      ),
      // Not sortable, and not an oversight: cost is a read-time rollup of
      // `recipe.totals x scale` summed in JS, carrying a `pending` flag for
      // recipes that have no totals yet. A SQL ORDER BY would have to
      // COALESCE those to 0 and rank a pending meal as the cheapest — sorting
      // by a number that isn't the one on screen. It resolves to
      // `enableSorting: false` via the `mealSortableFields` allowlist.
      columnHelper.accessor((row) => row.totals.costTotal, {
        id: "cost",
        header: "Cost",
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
      }),
    ],
    [columnHelper, nameEditable],
  );

  // Neither `buildFilters` nor `filters` is passed: the `meal` entry in
  // `entities/filter-manifest.tsx` drives the Type/Kind header controls, the
  // server `MealFilters` object, and the URL round-trip at once.
  const { workbench } = useEntityList<MealOut, MealFilters>({
    entity: "meal",
    queryOptions: api.meal.list.queryOptions,
    columns,
    deletable: deletableConfig,
    // Same fallback the Name column uses, so the confirm dialog names an
    // unnamed meal by its date instead of its UUID.
    deleteEmptyLabel: mealDateLabel,
  });

  return (
    <div>
      <ListWorkbench model={workbench} ariaLabel="Meals Table" />
    </div>
  );
}
