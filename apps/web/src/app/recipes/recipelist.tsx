import type { RecipeOut } from "@cubby/schemas/recipe";
import { getNutrientValueByKey } from "@cubby/usda-schemas";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";
import { ExternalLink, Scale } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Skeleton } from "~/components/ui/skeleton";
import { queryKeys } from "~/lib/query-keys";
import {
  type CalculateTotalsResult,
  calculateTotals,
} from "~/lib/recipe-costing";
import { formatCurrency } from "~/lib/utils";
import { chunk, ID_CHUNK_SIZE } from "~/misc/array-helpers";
import type { IngredientWithFoodOut } from "~/server/services/ingredient.service";
import { useTRPC } from "~/trpc/react";
import RTable from "../_components/data-table/Table";
import { useDeletableConfig } from "../_components/hooks/useDeletableConfig";
import { useEntityList } from "../_components/hooks/useEntityList";
import { useEntityPreview } from "../_components/hooks/useEntityPreview";
import { useStableColumnState } from "../_components/hooks/useStableColumnState";
import { NoneState } from "../_components/NoneState";
import { RecipeTag } from "../_components/recipe/recipe-tag";
import {
  formatYield,
  getIngredientName,
} from "../_components/recipe/recipe-utils";
import { TruncatedList } from "../_components/TruncatedList";

interface RecipeListProps {
  /** Actions to display in the table toolbar (e.g., "Create New" button) */
  actions?: ReactNode;
  /**
   * Scope the list to a single cookbook (its `SourceData` name). Set on the
   * cookbook detail / browse-by-source page; the table then shows only that
   * book's recipes. Undefined on the main recipes page (shows everything).
   */
  bookFilter?: string;
}

export function RecipeList({ actions, bookFilter }: RecipeListProps) {
  const api = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const columnHelper = createColumnHelper<RecipeOut>();
  const { onRowClick, PreviewSheet } = useEntityPreview("recipe");

  // State for async computed data (cost/calories)
  const [ingredientMap, setIngredientMap] = useState<Record<
    string,
    IngredientWithFoodOut
  > | null>(null);
  const [recipeTotalsMap, setRecipeTotalsMap] = useState<
    Record<string, CalculateTotalsResult>
  >({});
  const [isLoadingTotals, setIsLoadingTotals] = useState(false);

  // Use stable ref to avoid stale closures in column cell renderers
  const stateRef = useStableColumnState({
    ingredientMap,
    recipeTotalsMap,
    isLoadingTotals,
  });

  // Define columns with access to state (columns re-create when state changes, but IDs stay stable)
  // biome-ignore lint/correctness/useExhaustiveDependencies: stateRef is a ref - intentionally excluded to avoid re-renders
  const columns = useMemo(
    () => [
      // Tags column
      columnHelper.accessor("tags", {
        header: "Tags",
        enableSorting: false,
        meta: {
          className: "w-48",
          mobile: { slot: "subtitle", priority: 10 },
        },
        cell: (info) => {
          const tags = info.getValue();
          if (!tags?.length) return <NoneState />;
          return (
            <TruncatedList
              items={tags}
              maxItems={2}
              renderItem={(tag) => <RecipeTag key={tag} tag={tag} size="sm" />}
            />
          );
        },
      }),
      // Yield column
      columnHelper.display({
        id: "yield",
        header: "Yield",
        enableSorting: false,
        meta: {
          className: "w-24",
          mobile: { slot: "meta", priority: 20 },
        },
        cell: (info) => {
          const recipe = info.row.original;
          if (recipe.yield) return formatYield(recipe.yield);
          if (recipe.servings) return `${recipe.servings} servings`;
          return <NoneState />;
        },
      }),
      // Total cost column
      columnHelper.display({
        id: "totalCost",
        header: "Cost",
        enableSorting: false,
        meta: {
          className: "w-24",
          mobile: { slot: "trailing", priority: 5 },
        },
        cell: (info) => {
          const recipe = info.row.original;
          // Read from ref to get latest state (avoids stale closure)
          const { ingredientMap, recipeTotalsMap, isLoadingTotals } =
            stateRef.current;
          const totals = recipeTotalsMap[recipe.id];
          // Show skeleton while loading or if totals not yet calculated for this recipe
          if (isLoadingTotals || ingredientMap === null || !totals)
            return <Skeleton className="h-4 w-12" />;
          if (!totals.price) return <NoneState />;
          const withPrice =
            totals.totalIngredients - totals.missingByType.price.length;
          return (
            <span title={`${withPrice}/${totals.totalIngredients} ingredients`}>
              {formatCurrency(totals.price)}
              <span className="ml-1 text-2xs text-muted-foreground">
                ({withPrice}/{totals.totalIngredients})
              </span>
            </span>
          );
        },
      }),
      // Total calories column
      columnHelper.display({
        id: "totalCalories",
        header: "Calories",
        enableSorting: false,
        meta: {
          className: "w-28",
          mobile: { slot: "trailing", priority: 10 },
        },
        cell: (info) => {
          const recipe = info.row.original;
          // Read from ref to get latest state (avoids stale closure)
          const { ingredientMap, recipeTotalsMap, isLoadingTotals } =
            stateRef.current;
          const totals = recipeTotalsMap[recipe.id];
          // Show skeleton while loading or if totals not yet calculated for this recipe
          if (isLoadingTotals || ingredientMap === null || !totals)
            return <Skeleton className="h-4 w-12" />;
          const calories = getNutrientValueByKey(totals.nutrients, "kcal");
          if (!calories) return <NoneState />;
          const withNutrients =
            totals.totalIngredients - totals.missingByType.nutrients.length;
          return (
            <span
              title={`${withNutrients}/${totals.totalIngredients} ingredients`}
            >
              {Math.round(calories)} kcal
              <span className="ml-1 text-2xs text-muted-foreground">
                ({withNutrients}/{totals.totalIngredients})
              </span>
            </span>
          );
        },
      }),
      // Meta (source URL) column
      columnHelper.accessor("meta", {
        header: "Source",
        enableSorting: false,
        meta: {
          className: "w-44",
          mobile: { slot: "meta", priority: 30 },
        },
        cell: (info) => {
          const url = info.getValue()?.url;
          if (!url) return <NoneState />;
          return (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              <ExternalLink size={14} />
              <span className="max-w-[200px] truncate">{url}</span>
            </a>
          );
        },
      }),
    ],
    [columnHelper],
  );

  const deletableConfig = useDeletableConfig({
    mutationFn: api.recipe.delete.mutationOptions,
    entityLabel: "Recipe",
    invalidateKeys: [[queryKeys.recipe.list]],
  });

  const {
    table,
    isLoading,
    error,
    timing,
    data,
    bulkActionBar,
    deleteDialog,
    infiniteScroll,
    refreshControls,
  } = useEntityList({
    entity: "recipe",
    queryOptions: api.recipe.list.queryOptions,
    buildFilters: (ts) => ({
      nameFilter: ts.getColumnFilter("name"),
      // Constant scope when rendered on a cookbook page; merged with the
      // table's own name filter so search-within-a-book still works.
      ...(bookFilter ? { book: bookFilter } : {}),
    }),
    columns,
    nameClassName: "w-64",
    filters: [
      { id: "name", placeholder: "Filter by recipe name..." },
      { id: "meta", placeholder: "Filter by source..." },
    ],
    bulkActions: {
      actions: [
        {
          id: "compare",
          label: "Compare",
          icon: <Scale className="h-4 w-4" />,
          minSelection: 2,
          maxSelection: 4,
          onExecute: (rows) => {
            const ids = rows.map((r) => r.original.id).join(",");
            navigate({ to: "/recipes/compare", search: { ids } });
            return Promise.resolve({ success: true });
          },
        },
      ],
      clearSelectionOnComplete: false, // Don't clear selection after navigating
    },
    deletable: deletableConfig,
    infinite: true,
  });

  // `data` (the flattened infinite-query result) gets a fresh array reference on
  // every refetch/stream tick even when its content is unchanged. Depending on it
  // directly made this effect re-run ~16× per page load — re-fetching every
  // ingredient and recomputing every recipe's cost each time (a render storm plus
  // thousands of WASM conversions). Trigger on a stable content signature instead
  // and read the latest `data` through a ref.
  const dataRef = useRef(data);
  dataRef.current = data;
  const dataSignature = useMemo(
    () =>
      data
        .map(
          (r) =>
            `${r.id}:${r.sections
              .flatMap((s) =>
                s.ingredients.map((i) =>
                  i.type === "ingredient" ? i.ingredient.id : "",
                ),
              )
              .join("-")}`,
        )
        .join(","),
    [data],
  );

  // Load ingredient data and calculate totals in a single effect
  // biome-ignore lint/correctness/useExhaustiveDependencies: triggers on dataSignature; reads data via dataRef
  useEffect(() => {
    let cancelled = false;
    const recipes = dataRef.current;

    async function loadAndCalculate() {
      // No recipes - nothing to calculate
      if (recipes.length === 0) {
        setIngredientMap({});
        setRecipeTotalsMap({});
        setIsLoadingTotals(false);
        return;
      }

      // Set loading BEFORE any async work
      setIsLoadingTotals(true);

      try {
        // Extract unique ingredient IDs from all recipes
        const ingredientIds = new Set<string>();
        for (const recipe of recipes) {
          for (const section of recipe.sections) {
            for (const ing of section.ingredients) {
              if (ing.type === "ingredient") {
                ingredientIds.add(ing.ingredient.id);
              }
            }
          }
        }

        // Step 1: Load all ingredient data via batched getManyByIDs, chunked
        // (sorted → stable cache keys) to stay under the batch link's
        // maxURLLength. Replaces ~one getByID per ingredient (hundreds of DB
        // queries) with a handful of batched round-trips; ensureQueryData caches
        // each chunk so revisits reuse it.
        const ids = Array.from(ingredientIds).sort();
        const chunkResults = await Promise.all(
          chunk(ids, ID_CHUNK_SIZE).map((idChunk) =>
            queryClient.ensureQueryData(
              api.ingredient.getManyByIDs.queryOptions({ ids: idChunk }),
            ),
          ),
        );
        const ingredients = chunkResults.flat();

        if (cancelled) return;

        const ingMap = Object.fromEntries(
          ingredients.map((ing) => [ing.id, ing]),
        ) as Record<string, IngredientWithFoodOut>;

        setIngredientMap(ingMap);

        // Step 2: Calculate totals for all recipes (even if no ingredients)
        const entries = recipes.map((recipe) => {
          const recipeIngredients = recipe.sections.flatMap(
            (s) => s.ingredients,
          );
          const totals = calculateTotals(
            recipeIngredients,
            ingMap,
            getIngredientName,
          );
          return [recipe.id, totals] as const;
        });

        if (cancelled) return;

        setRecipeTotalsMap(Object.fromEntries(entries));
      } catch (e) {
        console.error("Failed to load recipe totals:", e);
        if (!cancelled) {
          setIngredientMap({});
          setRecipeTotalsMap({});
        }
      } finally {
        if (!cancelled) {
          setIsLoadingTotals(false);
        }
      }
    }

    loadAndCalculate();

    return () => {
      cancelled = true;
    };
  }, [queryClient, api, dataSignature]);

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
