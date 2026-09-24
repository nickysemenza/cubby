import { hasKnownEstimate } from "@cubby/schemas/nutrition";
import type { RecipeListItem } from "@cubby/schemas/recipe";
import { ArrowCounterClockwiseIcon as RotateCcw } from "@phosphor-icons/react/dist/csr/ArrowCounterClockwise";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import {
  numberCellData,
  specFromCellData,
  tagsCellData,
} from "~/app/_components/data-table/cell-data";
import { EditableCell } from "~/app/_components/data-table/editable-cell";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
} from "~/app/_components/data-table/table-features";
import { attachCubbyColumnMeta } from "~/app/_components/data-table/table-meta";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { useCookbookOptions } from "~/app/_components/hooks/useCookbookOptions";
import { useDeletableConfig } from "~/app/_components/hooks/useDeletableConfig";
import { useFilterOptions } from "~/app/_components/hooks/useFilterOptions";
import { useRecipeTagOptions } from "~/app/_components/hooks/useRecipeTagOptions";
import { useUpdateMutation } from "~/app/_components/hooks/useUpdateMutation";
import { EditableTagsCell } from "~/app/_components/recipe/editable-tags-cell";
import { RecipeTag } from "~/app/_components/recipe/recipe-tag";
import {
  formatRecipeTime,
  formatYield,
  getServingBasis,
  perUnitSuffix,
} from "~/app/_components/recipe/recipe-utils";
import { TruncatedList } from "~/app/_components/TruncatedList";
import { totalsLookStuck } from "~/app/recipes/recipe-totals-staleness";
import { recipe as recipeOperations } from "~/app/recipes/recipe.functions";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import type { FilterableComboboxItem } from "~/components/ui/combobox";
import { NoneValue } from "~/components/ui/none-value";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import { entityListHiddenColumns } from "~/entities/entity-display";
import type { EntityListParamsByEntity } from "~/entities/generated/entity-lists.gen";
import { scaleEstimate } from "~/lib/nutrition-estimates";
import { formatEstimate } from "~/lib/nutrition-format";
import { countLabel } from "~/lib/pluralize";
import { relatedData } from "~/lib/related-data.functions";
import { formatCurrency } from "~/lib/utils";

import { defineListOverride } from "./types";

type RecipeFilters = EntityListParamsByEntity["recipe"]["filters"];

const columnHelper = createCubbyColumnHelper<RecipeListItem>();
const NO_INGREDIENT_OPTIONS: FilterableComboboxItem[] = [];
const RECIPE_INITIAL_COLUMN_VISIBILITY = entityListHiddenColumns("recipe");

/**
 * The cell shown when a recipe's totals are null but it's plausibly stuck: a
 * "Pending" marker plus, on the cost column, a one-click recompute.
 */
function StuckTotalsCell({
  recipe,
  withAction,
}: {
  recipe: RecipeListItem;
  withAction: boolean;
}) {
  const recompute = useActionMutation({
    mutationFn: recipeOperations.recomputeOne.mutationOptions,
    success: "Recomputed recipe totals.",
  });
  const notCosted = (
    <span className="text-2xs text-muted-foreground">Pending</span>
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
        title="Recompute this recipe's cost and nutrition"
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

export const recipeListOverride = defineListOverride<
  RecipeListItem,
  RecipeFilters
>({
  use() {
    const { options: tagOptions } = useRecipeTagOptions();
    const { options: cookbookOptions } = useCookbookOptions();
    const ingredientOptionsQuery = useQuery(
      relatedData.options.queryOptions({
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

    const updateRecipeMutation = useUpdateMutation({
      mutationFn: entityMutationOptionsFactory("recipe", "update"),
      entity: "recipe",
    });
    // Its own config, not the contract default: a recipe write from this
    // table only moves `recipe.list`, not the meal rollups.
    const deletable = useDeletableConfig({
      mutationFn: entityMutationOptionsFactory("recipe", "delete"),
      entityLabel: "Recipe",
      entity: "recipe",
    });

    const overrides = useMemo(() => {
      // The cellData drives both the range copy/paste engine and the
      // focused-cell clipboard — one source of truth for tag save semantics.
      const saveTags = async (
        row: RecipeListItem,
        nextTags: string[] | null,
      ) => {
        await updateRecipeMutation.mutateAsync({
          id: row.id,
          data: { tags: nextTags },
        });
      };
      const tagsCellDataDef = tagsCellData<RecipeListItem>(
        (row) => row.tags ?? null,
        saveTags,
      );
      // Yield falls back to inline-editable `servings` only when the recipe
      // has no structured yield; copy/paste is available on exactly those rows.
      const saveServings = async (
        row: RecipeListItem,
        value: number | null,
      ) => {
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
      return createCubbyColumnCollection<RecipeListItem>((add) => {
        add(
          columnHelper.accessor("tags", {
            id: "tags",
            header: "Tags",
            enableSorting: true,
            meta: attachCubbyColumnMeta({
              className: "w-48",
              mobile: { slot: "subtitle", priority: 10 },
              cellData: tagsCellDataDef,
            }),
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
        );
        // Accessor (not display) so it sorts server-side on `servings`.
        add(
          columnHelper.accessor((row) => row.servings ?? undefined, {
            id: "yield",
            header: "Yield",
            meta: attachCubbyColumnMeta({
              numeric: true,
              className: "w-24",
              mobile: { slot: "trailing", priority: 5, interactive: true },
              cellData: servingsCellDataDef,
            }),
            cell: (info) => {
              const recipe = info.row.original;
              // A structured yield is owned by the detail page's editor.
              if (recipe.yield) return formatYield(recipe.yield);
              return (
                <EditableCell
                  value={recipe.servings ?? null}
                  config={{ type: "number" }}
                  clipboard={specFromCellData(servingsCellDataDef, recipe)}
                  renderValue={(servings) =>
                    servings == null ? (
                      <NoneValue />
                    ) : (
                      countLabel(servings, "serving")
                    )
                  }
                  onSave={(newValue) => saveServings(recipe, newValue)}
                />
              );
            },
          }),
        );
        for (const metric of ["cost", "kcal"] as const) {
          const getEstimate = (row: RecipeListItem) =>
            metric === "cost" ? row.totals?.cost : row.totals?.nutrition.kcal;
          const format =
            metric === "cost"
              ? formatCurrency
              : (value: number) => `${Math.round(value)} kcal`;
          add(
            columnHelper.accessor(
              (row) => {
                const estimate = getEstimate(row);
                return estimate && hasKnownEstimate(estimate)
                  ? estimate.lower
                  : undefined;
              },
              {
                id: metric === "cost" ? "costTotal" : "caloriesTotal",
                header: metric === "cost" ? "Cost" : "Calories",
                meta: {
                  numeric: true,
                  className: "w-32",
                  mobile: {
                    slot: "trailing",
                    priority: metric === "cost" ? 5 : 10,
                  },
                },
                sortUndefined: "last",
                cell: (info) => {
                  const recipe = info.row.original;
                  const estimate = getEstimate(recipe);
                  if (!estimate || estimate.status === "pending")
                    return totalsLookStuck(recipe) ? (
                      <StuckTotalsCell
                        recipe={recipe}
                        withAction={metric === "cost"}
                      />
                    ) : (
                      <span className="text-muted-foreground">Pending</span>
                    );
                  const perItem = getServingBasis(recipe);
                  return (
                    <Stack gap="xs">
                      <span
                        title={
                          hasKnownEstimate(estimate)
                            ? `${estimate.coverage.covered}/${estimate.coverage.total} ingredient rows covered`
                            : undefined
                        }
                      >
                        {formatEstimate(estimate, format)}
                      </span>
                      {perItem && hasKnownEstimate(estimate) && (
                        <div className="text-2xs text-muted-foreground">
                          {formatEstimate(
                            scaleEstimate(estimate, 1 / perItem.divisor),
                            format,
                          )}{" "}
                          {perUnitSuffix(perItem.noun, { short: true })}
                        </div>
                      )}
                    </Stack>
                  );
                },
              },
            ),
          );
        }
        // Accessor on `totalMinutes` so sorting and the range filter are the
        // server's column, while the cell prints the source's own prose.
        add(
          columnHelper.accessor(
            (row) => row.meta?.times?.totalMinutes ?? undefined,
            {
              id: "totalMinutes",
              header: "Time",
              meta: {
                numeric: true,
                className: "w-24",
                mobile: { slot: "meta", priority: 25 },
              },
              sortUndefined: "last",
              cell: (info) => {
                const times = info.row.original.meta?.times;
                const label = formatRecipeTime(
                  times?.total,
                  times?.totalMinutes,
                );
                return label ?? <NoneValue />;
              },
            },
          ),
        );
        // A live MealRecipe under a soft-deleted Meal doesn't count.
        add(
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
                <span className="tabular-nums">{count}</span>
              ) : (
                <NoneValue />
              );
            },
          }),
        );
      });
      // oxlint-disable-next-line react/exhaustive-deps -- updateRecipeMutation changes every render but is functionally stable
    }, []);

    const list = useMemo(
      () => ({
        deletable,
        filterOptions,
        initialColumnVisibility: RECIPE_INITIAL_COLUMN_VISIBILITY,
      }),
      [deletable, filterOptions],
    );
    return { overrides, list };
  },
});
