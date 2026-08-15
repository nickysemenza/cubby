import type { MealOut } from "@cubby/schemas/meal";
import {
  MEAL_KIND_LABELS,
  MEAL_TYPE_LABELS,
  type MealKind,
  type MealType,
} from "@cubby/schemas/meal-classification";
import { useQuery } from "@tanstack/react-query";
import { createColumnHelper } from "@tanstack/react-table";
import { format, parseISO } from "date-fns";
import { useMemo } from "react";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { Badge } from "~/components/ui/badge";
import { manifestFilterConfig } from "~/entities/filter-manifest";
import { useTRPC } from "~/integrations/trpc/react";
import { mealMutationInvalidateKeys } from "~/lib/query-keys";
import {
  createFilterableSelectColumn,
  createNameColumn,
  createPlainDateColumn,
} from "../_components/data-table/columnHelpers";
import RTable from "../_components/data-table/Table";
import { EntityInlineLinkList } from "../_components/EntityInlineLinkList";
import { useClientEntityList } from "../_components/hooks/useClientEntityList";
import { useDeletableConfig } from "../_components/hooks/useDeletableConfig";
import { useUpdateMutation } from "../_components/hooks/useUpdateMutation";
import { formatMealCost } from "./meal-format";
import {
  mealKindBadgeVariant,
  mealKindOptions,
  mealTypeOptions,
} from "./meal-options";

/** Stable empty default — never a fresh `[]` per render (would churn memos). */
const NO_MEALS: MealOut[] = [];

/** Single-user scale, like the task inbox: one bounded fetch, no server
 * pagination — `useClientEntityList` sorts/paginates client-side. */
const MEAL_TABLE_PAGE_SIZE = 500;

/**
 * The `/meals?view=table` surface — the CRUD-complete sibling of the
 * calendar view: inline rename/reschedule, delete (row + bulk), and a
 * `/meals` header "New" action (wired in meals.index.tsx)
 * that the calendar-only "+ Meal" affordance never covered.
 *
 * `useClientEntityList`, not `useEntityList`: `meal.list`'s `orderBy` types
 * as a `z.enum(mealSortableFields)` (`["date","createdAt"]`), so a
 * server-sorted table would 400 the instant someone clicks the Name or Cost
 * header. Client-side sorting sidesteps that entirely.
 */
/**
 * How an unnamed meal identifies itself — matching the detail page's title
 * fallback. Shared by the Name column and the delete dialog so the two can't
 * disagree about what a row is called.
 */
const mealDateLabel = (row: { date: string }) =>
  format(parseISO(row.date), "EEE, MMM d");

export function MealTable() {
  const api = useTRPC();
  const columnHelper = useMemo(() => createColumnHelper<MealOut>(), []);

  const { data, isLoading } = useQuery(
    api.meal.list.queryOptions({
      filters: {},
      pagination: { pageIndex: 0, pageSize: MEAL_TABLE_PAGE_SIZE },
    }),
  );
  const meals = data?.items ?? NO_MEALS;

  const updateMealMutation = useUpdateMutation({
    mutationFn: api.meal.update.mutationOptions,
    entity: "meal",
    invalidateKeys: mealMutationInvalidateKeys,
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
    invalidateKeys: mealMutationInvalidateKeys,
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

  const { table, bulkActionBar, deleteDialog } = useClientEntityList({
    entity: "meal",
    data: meals,
    columns,
    deletable: deletableConfig,
    // Same fallback the Name column uses, so the confirm dialog names an
    // unnamed meal by its date instead of its UUID.
    deleteEmptyLabel: mealDateLabel,
  });

  if (isLoading) return <SimpleLoading text="Loading meals..." />;

  return (
    <div>
      <RTable
        table={table}
        ariaLabel="Meals Table"
        entity="meal"
        bulkActionBar={bulkActionBar}
      />
      {deleteDialog}
    </div>
  );
}
