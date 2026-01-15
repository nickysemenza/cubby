import { getNutrientValueByKey } from "@recipehub/usda-schemas";
import { useNavigate } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";
import { ExternalLink, Scale } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Skeleton } from "~/components/ui/skeleton";
import { queryKeys } from "~/lib/query-keys";
import { formatCurrency } from "~/lib/utils";
import type { RecipeOut } from "~/schemas/recipe";
import type { IngredientWithFoodOut } from "~/server/services/ingredient.service";
import { useTRPC, useTRPCClient } from "~/trpc/react";
import RTable from "../_components/data-table/Table";
import { useDeletableConfig } from "../_components/hooks/useDeletableConfig";
import { useEntityList } from "../_components/hooks/useEntityList";
import { useEntityPreview } from "../_components/hooks/useEntityPreview";
import { useStableColumnState } from "../_components/hooks/useStableColumnState";
import { NoneState } from "../_components/NoneState";
import { RecipeTag } from "../_components/recipe/recipe-tag";
import { getIngredientName } from "../_components/recipe/recipeutils";
import { TruncatedList } from "../_components/TruncatedList";
import {
  type CalculateTotalsResult,
  calculateTotals,
} from "../_components/units/univ-conversion";

interface RecipeListProps {
  /** Actions to display in the table toolbar (e.g., "Create New" button) */
  actions?: ReactNode;
}

export function RecipeList({ actions }: RecipeListProps) {
  const api = useTRPC();
  const trpcClient = useTRPCClient();
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
        cell: (info) => {
          const recipe = info.row.original;
          if (recipe.yield) return `${recipe.yield.value} ${recipe.yield.unit}`;
          if (recipe.servings) return `${recipe.servings} servings`;
          return <NoneState />;
        },
      }),
      // Total cost column
      columnHelper.display({
        id: "totalCost",
        header: "Cost",
        enableSorting: false,
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
              <span className="ml-1 text-[10px] text-muted-foreground">
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
              <span className="ml-1 text-[10px] text-muted-foreground">
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

  const { table, isLoading, error, timing, data, bulkActionBar, deleteDialog } =
    useEntityList({
      entity: "recipe",
      queryOptions: api.recipe.list.queryOptions,
      buildFilters: (ts) => ({
        nameFilter: ts.getColumnFilter("name"),
      }),
      columns,
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
    });

  // Load ingredient data and calculate totals in a single effect
  useEffect(() => {
    let cancelled = false;

    async function loadAndCalculate() {
      // No recipes - nothing to calculate
      if (data.length === 0) {
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
        for (const recipe of data) {
          for (const section of recipe.sections) {
            for (const ing of section.ingredients) {
              if (ing.type === "ingredient") {
                ingredientIds.add(ing.ingredient.id);
              }
            }
          }
        }

        // Step 1: Load all ingredient data (may be empty if no ingredients)
        const ingredients = await Promise.all(
          Array.from(ingredientIds).map((id) =>
            trpcClient.ingredient.getByID.query({ id }),
          ),
        );

        if (cancelled) return;

        const ingMap = Object.fromEntries(
          ingredients.map((ing) => [ing.id, ing]),
        ) as Record<string, IngredientWithFoodOut>;

        setIngredientMap(ingMap);

        // Step 2: Calculate totals for all recipes (even if no ingredients)
        const entries = data.map((recipe) => {
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
  }, [trpcClient, data]);

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
      />
      <PreviewSheet />
      {deleteDialog}
    </div>
  );
}
