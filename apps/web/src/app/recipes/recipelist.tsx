import type { CookbookShortcode } from "@cubby/schemas/identifiers";
import { hasKnownEstimate } from "@cubby/schemas/nutrition";
import type { RecipeListItem } from "@cubby/schemas/recipe";
import { useQuery } from "@tanstack/react-query";
import { RotateCcw } from "lucide-react";
import { type ReactNode, useMemo } from "react";

import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
} from "~/app/_components/data-table/table-features";
import { attachCubbyColumnMeta } from "~/app/_components/data-table/table-meta";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import type { FilterableComboboxItem } from "~/components/ui/combobox";
import { NoneValue } from "~/components/ui/none-value";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import {
  createEntityDisplayColumns,
  entityListHiddenColumns,
} from "~/entities/entity-display";
import { entityListFor } from "~/entities/entity-list.functions";
import { scaleEstimate } from "~/lib/nutrition-estimates";
import { formatEstimate } from "~/lib/nutrition-format";
import { countLabel } from "~/lib/pluralize";
import { relatedData } from "~/lib/related-data.functions";
import { formatCurrency } from "~/lib/utils";

import {
  numberCellData,
  specFromCellData,
  tagsCellData,
} from "../_components/data-table/cell-data";
import { EditableCell } from "../_components/data-table/editable-cell";
import { EntityListPage } from "../_components/data-table/EntityListPage";
import { useActionMutation } from "../_components/hooks/useActionMutation";
import { useCookbookOptions } from "../_components/hooks/useCookbookOptions";
import { useDeletableConfig } from "../_components/hooks/useDeletableConfig";
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
  formatRecipeTime,
  formatYield,
  getServingBasis,
  perUnitSuffix,
} from "../_components/recipe/recipe-utils";
import { TruncatedList } from "../_components/TruncatedList";
import { totalsLookStuck } from "./recipe-totals-staleness";
import { recipe as recipeOperations } from "./recipe.functions";

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

// `notes` is declared `display.listHidden` on `01-recipe.entity.ts` now —
// module-level so `useEntityList`'s merged-visibility memo (keyed on
// referential identity) doesn't rebuild every render.
const RECIPE_INITIAL_COLUMN_VISIBILITY = entityListHiddenColumns("recipe");

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
  const columnHelper = useMemo(
    () => createCubbyColumnHelper<RecipeListItem>(),
    [],
  );

  // Runtime picklists for the manifest's `tags`/`source` specs (optionsKey:
  // "tags" / "cookbook"). Constant scope when rendered on a cookbook page.
  const cookbookScope = useMemo(
    () => (cookbookIdFilter ? { cookbookId: cookbookIdFilter } : {}),
    [cookbookIdFilter],
  );

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

  // Mutation for inline editing (name, servings).
  const updateRecipeMutation = useUpdateMutation({
    mutationFn: entityMutationOptionsFactory("recipe", "update"),
    entity: "recipe",
  });

  // Inline name editing on the hook-prepended name column. Stable reference
  // required (feeds the columns memo); the mutation's mutateAsync is stable.
  const nameEditable = useMemo(
    () => ({
      onSave: async (newName: string, recipe: RecipeListItem) => {
        await updateRecipeMutation.mutateAsync({
          id: recipe.id,
          data: { name: newName },
        });
      },
    }),
    // oxlint-disable-next-line react/exhaustive-deps -- updateRecipeMutation changes every render but is functionally stable
    [],
  );

  // Memoize columns; updateRecipeMutation is NOT in dependencies because
  // useMutation returns a new object every render, but the closure captures
  // it correctly — see productlist.tsx for the same pattern.
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
    // All seven columns below are declared `list: true` on the recipe entity
    // but rendered specially here (inline-editable tags/yield, computed
    // cost/calories/time, a source link, a meal count), so each is an
    // override matched by column id rather than a generic scalar —
    // `docs/entities.md`'s "declaration wins" column-building rule. `yield`
    // keeps its existing column id via `display.columnId` on `servings`
    // (persisted layouts, filter bindings, and sort ids can't silently
    // rename); the rest already share their column id with the field key.
    return createCubbyColumnCollection<RecipeListItem>((add) => {
      createEntityDisplayColumns(
        "recipe",
        columnHelper,
        createCubbyColumnCollection<RecipeListItem>((add) => {
          // Tags column
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
          // Yield column. Accessor (not display) so it sorts server-side; the
          // accessorFn exposes `servings` (recipeList orders "yield" by it),
          // while the cell still shows yield-or-servings.
          add(
            columnHelper.accessor((row) => row.servings ?? undefined, {
              id: "yield",
              header: "Yield",
              meta: attachCubbyColumnMeta({
                numeric: true,
                className: "w-24",
                // Mobile: yield/servings is the most useful at-a-glance
                // datum, and recipe rows have no image — surface it as the
                // row subtitle.
                mobile: { slot: "subtitle", priority: 5, interactive: true },
                cellData: servingsCellDataDef,
              }),
              cell: (info) => {
                const recipe = info.row.original;
                // A structured yield ("2 loaves") is authoritative and owned
                // by the detail page's yield editor — read-only here. Only
                // recipes with no structured yield fall back to the plain
                // servings count, which is safe to edit inline.
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
          // Total time — the weeknight axis. Accessor on `totalMinutes` so
          // sorting and the range filter are the server's
          // `Recipe.totalMinutes` column, but the cell prints the source's
          // own prose whenever there is one: a present string does NOT imply
          // a present count, and vice versa, so a recipe can show "about 1½
          // hours" here while sorting on nothing at all.
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
          // Source column: cookbook link for book recipes, external URL for
          // web recipes, nothing otherwise — via the shared RecipeSourceLink.
          add(
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
          );
          // Meals column: how many live meal plans use this recipe. A live
          // MealRecipe under a soft-deleted Meal doesn't count (see
          // liveMealCountForRecipeSql) — mirrors the "meals" presence filter.
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
                  <span className="font-mono tabular-nums">{count}</span>
                ) : (
                  <NoneValue />
                );
              },
            }),
          );
        }),
      ).visit(add);
    });
    // oxlint-disable-next-line react/exhaustive-deps -- updateRecipeMutation changes every render but is functionally stable
  }, [columnHelper]);

  const deletableConfig = useDeletableConfig({
    mutationFn: entityMutationOptionsFactory("recipe", "delete"),
    entityLabel: "Recipe",
    entity: "recipe",
  });

  return (
    <EntityListPage
      entity="recipe"
      queryOptions={entityListFor("recipe").listQueryPlan}
      // Constant scope when rendered on a cookbook page; merged over the
      // table's own column filters so search-within-a-book still works.
      scopeFilters={cookbookScope}
      filterOptions={filterOptions}
      columns={columns}
      initialColumnVisibility={RECIPE_INITIAL_COLUMN_VISIBILITY}
      nameClassName="w-64"
      hiddenFilterColumns={hiddenFilterColumns}
      // Its own config, not the contract default: a recipe write from this
      // table only moves `recipe.list`, not the meal rollups the contract's
      // broader fan-out covers.
      deletable={deletableConfig}
      nameEditable={nameEditable}
      ariaLabel="Recipes Table"
      actions={actions}
    />
  );
}
