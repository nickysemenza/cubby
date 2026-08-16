import type { CookbookShortcode } from "@cubby/schemas/identifiers";
import type { RecipeListItem } from "@cubby/schemas/recipe";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";
import { RotateCcw } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { verbBulkAction } from "~/app/_components/actions/action-verb-ui";
import { Row, Stack } from "~/components/layout";
import { usePageCount } from "~/components/page/Page";
import { Button } from "~/components/ui/button";
import type { FilterableComboboxItem } from "~/components/ui/combobox";
import { NoneValue } from "~/components/ui/none-value";
import { Skeleton } from "~/components/ui/skeleton";
import { useTRPC } from "~/integrations/trpc/react";
import { formatCurrencyRange, formatNumberRange } from "~/lib/format-range";
import { recipeMutationInvalidateKeys } from "~/lib/query-keys";
import {
  numberCellData,
  specFromCellData,
  tagsCellData,
} from "../_components/data-table/cell-data";
import { EditableCell } from "../_components/data-table/editable-cell";
import RTable from "../_components/data-table/Table";
import { useActionMutation } from "../_components/hooks/useActionMutation";
import { useCookbookOptions } from "../_components/hooks/useCookbookOptions";
import { useDeletableConfig } from "../_components/hooks/useDeletableConfig";
import { useEntityList } from "../_components/hooks/useEntityList";
import { useEntityPreview } from "../_components/hooks/useEntityPreview";
import { useFilterOptions } from "../_components/hooks/useFilterOptions";
import { useRecipeTagOptions } from "../_components/hooks/useRecipeTagOptions";
import { useUpdateMutation } from "../_components/hooks/useUpdateMutation";
import { EditableTagsCell } from "../_components/recipe/editable-tags-cell";
import {
  RecipeSourceLink,
  sourceLabel,
} from "../_components/recipe/recipe-source";
import { RecipeTag } from "../_components/recipe/recipe-tag";
import {
  coverageLabel,
  formatYield,
  getServingBasis,
  perServingRange,
  perUnitSuffix,
} from "../_components/recipe/recipe-utils";
import { TruncatedList } from "../_components/TruncatedList";
import { totalsLookStuck } from "./recipe-totals-staleness";

/**
 * A computed list-cell value (cost, calories) whose confidence depends on how
 * many of the recipe's ingredients had the underlying data. When coverage is
 * complete the value stands on its own — no fraction. When partial, the value is
 * preliminary, so it's greyed and annotated with the (covered/total) fraction.
 */
const CoverageValue: React.FC<{
  covered: number;
  total: number;
  children: ReactNode;
}> = ({ covered, total, children }) => {
  const { complete, fraction } = coverageLabel(covered, total);
  return (
    <span
      className={complete ? undefined : "opacity-60"}
      title={`${fraction} ingredients`}
    >
      {children}
      {!complete && (
        <span className="ml-1 hidden text-2xs text-muted-foreground sm:inline">
          ({fraction})
        </span>
      )}
    </span>
  );
};

const NO_INGREDIENT_OPTIONS: FilterableComboboxItem[] = [];

/**
 * The cell shown when a recipe's totals are null but it's plausibly stuck: a
 * "not costed" marker plus, on the cost column, a one-click recompute (inline,
 * request-path — a single recipe is cheap) that fills the totals. Fresh recipes
 * keep the skeleton; only a stuck one reaches this.
 */
function StuckTotalsCell({
  recipe,
  withAction,
}: {
  recipe: RecipeListItem;
  /** Render the recompute button (cost column only, so a row shows it once). */
  withAction: boolean;
}) {
  const api = useTRPC();
  const recompute = useActionMutation({
    mutationFn: api.recipe.recomputeOne.mutationOptions,
    success: "Recomputed recipe totals.",
    invalidateKeys: recipeMutationInvalidateKeys,
  });
  const notCosted = (
    <span className="text-2xs text-muted-foreground italic">not costed</span>
  );
  if (!withAction) return notCosted;
  return (
    <Row align="center" gap="xs">
      {notCosted}
      <Button
        type="button"
        variant="outline"
        size="xs"
        disabled={recompute.isPending}
        title="Recompute this recipe's cost & calorie totals"
        onClick={(e) => {
          e.stopPropagation();
          recompute.mutate({ id: recipe.id });
        }}
      >
        <RotateCcw className={recompute.isPending ? "animate-spin" : ""} />
        Recompute
      </Button>
    </Row>
  );
}

interface RecipeListProps {
  /** Actions to display in the table toolbar (e.g., "Create New" button) */
  actions?: ReactNode;
  /**
   * Scope the list to a single cookbook by FK id. Set on the cookbook detail
   * page; the table then shows only that cookbook's recipes. Undefined on the
   * main recipes page (shows everything).
   */
  cookbookIdFilter?: CookbookShortcode;
  /**
   * Column ids to hide the header filter control for — the cookbook detail
   * page pins `cookbookId` via `cookbookIdFilter` above, which wins over
   * whatever the Source column's filter would pick, so it hides `["source"]`
   * rather than leave an interactive-but-inert control. See
   * `useStandardColumns`' doc comment.
   */
  hiddenFilterColumns?: string[];
}

export function RecipeList({
  actions,
  cookbookIdFilter,
  hiddenFilterColumns,
}: RecipeListProps) {
  const api = useTRPC();
  const navigate = useNavigate();
  const columnHelper = useMemo(() => createColumnHelper<RecipeListItem>(), []);
  const { onRowClick, onRowHover, PreviewSheet } = useEntityPreview("recipe");
  // Runtime picklists for the manifest's `tags`/`source` specs (optionsKey:
  // "tags" / "cookbook"). Constant scope when rendered on a cookbook page.
  const cookbookScope = useMemo(
    () => (cookbookIdFilter ? { cookbookId: cookbookIdFilter } : {}),
    [cookbookIdFilter],
  );

  const { options: tagOptions } = useRecipeTagOptions();
  const { options: cookbookOptions } = useCookbookOptions();
  const ingredientOptionsQuery = useQuery(
    api.relatedData.options.queryOptions({
      relationKey: "recipe.ingredients",
      limit: 100,
    }),
  );
  const ingredientOptions = useMemo<FilterableComboboxItem[]>(
    () =>
      ingredientOptionsQuery.data?.map(({ id, label, count }) => ({
        value: id,
        label,
        hint: String(count),
      })) ?? NO_INGREDIENT_OPTIONS,
    [ingredientOptionsQuery.data],
  );
  const filterOptions = useFilterOptions({
    tags: tagOptions,
    cookbook: cookbookOptions,
    recipeIngredients: ingredientOptions,
  });

  // Mutation for inline editing (name, servings).
  const updateRecipeMutation = useUpdateMutation({
    mutationFn: api.recipe.update.mutationOptions,
    entity: "recipe",
    invalidateKeys: recipeMutationInvalidateKeys,
  });

  // Inline name editing on the hook-prepended name column. Stable reference
  // required (feeds the columns memo); the mutation's mutateAsync is stable.
  // biome-ignore lint/correctness/useExhaustiveDependencies: updateRecipeMutation changes every render but is functionally stable
  const nameEditable = useMemo(
    () => ({
      onSave: async (newName: string, recipe: RecipeListItem) => {
        await updateRecipeMutation.mutateAsync({
          id: recipe.id,
          data: { name: newName },
        });
      },
    }),
    [],
  );

  // Memoize columns; updateRecipeMutation is NOT in dependencies because
  // useMutation returns a new object every render, but the closure captures
  // it correctly — see productlist.tsx for the same pattern.
  // biome-ignore lint/correctness/useExhaustiveDependencies: updateRecipeMutation changes every render but is functionally stable
  const columns = useMemo(() => {
    // Inline-editable, copy/pastable tags column. The cellData drives both the
    // range copy/paste engine (meta.cellData) and the focused-cell clipboard
    // (specFromCellData, per row) — one source of truth for tag save semantics.
    const saveTags = async (row: RecipeListItem, nextTags: string[] | null) => {
      await updateRecipeMutation.mutateAsync({
        id: row.id,
        data: { tags: nextTags },
      });
    };
    const tagsCellDataDef = tagsCellData<RecipeListItem>(
      (row) => row.tags ?? null,
      saveTags,
    );
    // Yield column falls back to inline-editable `servings` only when the recipe
    // has no structured yield ("2 loaves", owned by the detail page's editor).
    // The cellData mirrors that: copy is null on structured-yield rows (nothing
    // to offer), and paste is rejected there — so copy/paste is available on
    // exactly the rows where the inline editor is.
    const saveServings = async (row: RecipeListItem, value: number | null) => {
      if (row.yield) {
        throw new Error(
          "This recipe has a structured yield — edit servings on its detail page.",
        );
      }
      await updateRecipeMutation.mutateAsync({
        id: row.id,
        data: { servings: value === null ? null : Math.round(value) },
      });
    };
    const servingsCellDataDef = numberCellData<RecipeListItem>(
      "number",
      (row) => (row.yield ? null : (row.servings ?? null)),
      saveServings,
    );
    const renderTags = (tags: string[] | null) => {
      if (!tags?.length) return <NoneValue />;
      return (
        <TruncatedList
          items={tags}
          maxItems={2}
          renderItem={(tag) => <RecipeTag key={tag} tag={tag} size="sm" />}
        />
      );
    };
    return [
      // Tags column
      columnHelper.accessor("tags", {
        id: "tags",
        header: "Tags",
        enableSorting: true,
        meta: {
          className: "w-48",
          mobile: { slot: "subtitle", priority: 10 },
          cellData: tagsCellDataDef,
        },
        cell: (info) => {
          const recipe = info.row.original;
          return (
            <EditableTagsCell
              value={recipe.tags ?? null}
              renderValue={renderTags}
              clipboard={specFromCellData(tagsCellDataDef, recipe)}
              onSave={(nextTags) => saveTags(recipe, nextTags)}
            />
          );
        },
      }),
      // Yield column. Accessor (not display) so it sorts server-side; the
      // accessorFn exposes `servings` (recipeList orders "yield" by it), while
      // the cell still shows yield-or-servings.
      columnHelper.accessor((row) => row.servings ?? undefined, {
        id: "yield",
        header: "Yield",
        meta: {
          numeric: true,
          className: "w-24",
          // Mobile: yield/servings is the most useful at-a-glance datum, and
          // recipe rows have no image — surface it as the row subtitle.
          mobile: { slot: "subtitle", priority: 5, interactive: true },
          cellData: servingsCellDataDef,
        },
        cell: (info) => {
          const recipe = info.row.original;
          // A structured yield ("2 loaves") is authoritative and owned by the
          // detail page's yield editor — read-only here. Only recipes with no
          // structured yield fall back to the plain servings count, which is
          // safe to edit inline.
          if (recipe.yield) return formatYield(recipe.yield);
          return (
            <EditableCell<number>
              value={recipe.servings ?? null}
              config={{ type: "number" }}
              clipboard={specFromCellData(servingsCellDataDef, recipe)}
              renderValue={(servings) =>
                servings ? `${servings} servings` : <NoneValue />
              }
              onSave={(newValue) => saveServings(recipe, newValue)}
            />
          );
        },
      }),
      // Total cost — read from the server-persisted rollup (recipe.totals).
      // Accessor (not display) so the column sorts server-side by costTotal;
      // null totals = not yet computed (the drain will fill it) → skeleton.
      columnHelper.accessor((row) => row.totals?.costTotal ?? undefined, {
        id: "costTotal",
        header: "Cost",
        meta: {
          numeric: true,
          className: "w-24",
          mobile: { slot: "trailing", priority: 5 },
        },
        sortUndefined: "last",
        cell: (info) => {
          const recipe = info.row.original;
          const totals = recipe.totals;
          // Null totals = not yet computed. Fresh recipe → the drain is about to
          // fill it (skeleton); plausibly stuck → offer a manual recompute so the
          // skeleton doesn't animate forever.
          if (!totals)
            return totalsLookStuck(recipe) ? (
              <StuckTotalsCell recipe={recipe} withAction />
            ) : (
              <Skeleton className="h-4 w-12" />
            );
          if (!totals.costTotal) return <NoneValue />;
          const perItem = getServingBasis(recipe);
          return (
            <Stack gap="xs">
              <CoverageValue
                covered={totals.costCovered}
                total={totals.ingredientCount}
              >
                {formatCurrencyRange(totals.costTotal, totals.costTotalUpper)}
              </CoverageValue>
              {perItem &&
                (() => {
                  const per = perServingRange(
                    totals.costTotal,
                    totals.costTotalUpper,
                    perItem.divisor,
                  );
                  return (
                    <div className="text-2xs text-muted-foreground">
                      {formatCurrencyRange(per.value, per.upper)}{" "}
                      {perUnitSuffix(perItem.noun, { short: true })}
                    </div>
                  );
                })()}
            </Stack>
          );
        },
      }),
      // Total calories — server-persisted rollup.
      columnHelper.accessor((row) => row.totals?.caloriesTotal ?? undefined, {
        id: "caloriesTotal",
        header: "Calories",
        meta: {
          numeric: true,
          className: "w-28",
          mobile: { slot: "trailing", priority: 10 },
        },
        sortUndefined: "last",
        cell: (info) => {
          const recipe = info.row.original;
          const totals = recipe.totals;
          // Mirror the cost cell: skeleton while fresh, "not costed" once stuck
          // (the recompute affordance lives on the cost column so a row shows it
          // once).
          if (!totals)
            return totalsLookStuck(recipe) ? (
              <StuckTotalsCell recipe={recipe} withAction={false} />
            ) : (
              <Skeleton className="h-4 w-12" />
            );
          if (!totals.caloriesTotal) return <NoneValue />;
          const perItem = getServingBasis(recipe);
          return (
            <Stack gap="xs">
              <CoverageValue
                covered={totals.caloriesCovered}
                total={totals.ingredientCount}
              >
                {formatNumberRange(
                  totals.caloriesTotal,
                  totals.caloriesTotalUpper,
                  (n) => `${Math.round(n)}`,
                )}{" "}
                kcal
              </CoverageValue>
              {perItem &&
                (() => {
                  const per = perServingRange(
                    totals.caloriesTotal,
                    totals.caloriesTotalUpper,
                    perItem.divisor,
                  );
                  return (
                    <div className="text-2xs text-muted-foreground">
                      {formatNumberRange(
                        per.value,
                        per.upper,
                        (n) => `${Math.round(n)}`,
                      )}{" "}
                      kcal {perUnitSuffix(perItem.noun, { short: true })}
                    </div>
                  );
                })()}
            </Stack>
          );
        },
      }),
      // Source column: cookbook link for book recipes, external URL for web
      // recipes, nothing otherwise — via the shared RecipeSourceLink.
      columnHelper.accessor("source", {
        header: "Source",
        meta: {
          className: "w-44",
          mobile: { slot: "meta", priority: 30 },
        },
        cell: (info) => {
          const source = info.getValue();
          if (!sourceLabel(source)) return <NoneValue />;
          return (
            <RecipeSourceLink
              source={source}
              text="host"
              onClick={(e) => e.stopPropagation()}
            />
          );
        },
      }),
      // Meals column: how many live meal plans use this recipe. A live
      // MealRecipe under a soft-deleted Meal doesn't count (see
      // liveMealCountForRecipeSql) — mirrors the "meals" presence filter.
      columnHelper.accessor("mealCount", {
        id: "meals",
        header: "Meals",
        meta: {
          numeric: true,
          className: "w-20",
          mobile: { slot: "meta", priority: 40 },
        },
        cell: (info) => {
          const count = info.getValue();
          return count ? (
            <span className="font-mono tabular-nums">{count}</span>
          ) : (
            <NoneValue />
          );
        },
      }),
    ];
  }, [columnHelper]);

  const deletableConfig = useDeletableConfig({
    mutationFn: api.recipe.delete.mutationOptions,
    entityLabel: "Recipe",
    invalidateKeys: recipeMutationInvalidateKeys,
    entity: "recipe",
  });

  const {
    table,
    isLoading,
    error,
    timing,
    bulkActionBar,
    deleteDialog,
    infiniteScroll,
    refreshControls,
    totalCount,
  } = useEntityList({
    entity: "recipe",
    queryOptions: api.recipe.list.queryOptions,
    // Constant scope when rendered on a cookbook page; merged over the
    // table's own column filters so search-within-a-book still works.
    scopeFilters: cookbookScope,
    filterOptions,
    columns,
    nameClassName: "w-64",
    hiddenFilterColumns,
    bulkActions: {
      actions: [
        verbBulkAction<RecipeListItem>("compare", {
          minSelection: 2,
          onExecute: (rows) => {
            const ids = rows.map((r) => r.original.id).join(",");
            navigate({ to: "/recipes/compare", search: { ids } });
            return Promise.resolve({ success: true });
          },
        }),
      ],
      clearSelectionOnComplete: false, // Don't clear selection after navigating
    },
    deletable: deletableConfig,
    nameEditable,
  });
  usePageCount(totalCount);

  return (
    <div>
      <RTable
        table={table}
        isLoading={isLoading}
        error={error}
        ariaLabel="Recipes Table"
        timing={timing}
        entity="recipe"
        onRowClick={onRowClick}
        onRowHover={onRowHover}
        actions={actions}
        bulkActionBar={bulkActionBar}
        infiniteScroll={infiniteScroll}
        refreshControls={refreshControls}
      />
      <PreviewSheet />
      {deleteDialog}
    </div>
  );
}
