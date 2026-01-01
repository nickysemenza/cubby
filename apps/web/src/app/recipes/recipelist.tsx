import { getNutrientValueByKey } from "@recipehub/usda-schemas";
import { useNavigate } from "@tanstack/react-router";
import {
  createColumnHelper,
  type RowSelectionState,
} from "@tanstack/react-table";
import { Scale } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { formatCurrency } from "~/lib/utils";
import type { RecipeOut } from "~/schemas/recipe";
import type { IngredientWithFoodOut } from "~/server/services/ingredient.service";
import { useTRPC, useTRPCClient } from "~/trpc/react";
import RTable from "../_components/data-table/Table";
import { useEntityList } from "../_components/hooks/useEntityList";
import { useEntityPreview } from "../_components/hooks/useEntityPreview";
import { NoneState } from "../_components/NoneState";
import { RecipeTag } from "../_components/recipe/recipe-tag";
import { getIngredientName } from "../_components/recipe/recipeutils";
import { TruncatedList } from "../_components/TruncatedList";
import {
  type CalculateTotalsResult,
  calculateTotals,
} from "../_components/units/univ-conversion";

export function RecipeList() {
  const api = useTRPC();
  const trpcClient = useTRPCClient();
  const navigate = useNavigate();
  const columnHelper = createColumnHelper<RecipeOut>();
  const { onRowClick, PreviewSheet } = useEntityPreview("recipe");
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});

  // State for async computed data (cost/calories)
  const [ingredientMap, setIngredientMap] = useState<Record<
    string,
    IngredientWithFoodOut
  > | null>(null);
  const [recipeTotalsMap, setRecipeTotalsMap] = useState<
    Record<string, CalculateTotalsResult>
  >({});
  const [isLoadingTotals, setIsLoadingTotals] = useState(false);

  // Use ref to avoid stale closures in column cell renderers
  // TanStack Table caches columns, so closures capture old state values
  const stateRef = useRef({ ingredientMap, recipeTotalsMap, isLoadingTotals });
  stateRef.current = { ingredientMap, recipeTotalsMap, isLoadingTotals };

  // Define columns with access to state (columns re-create when state changes, but IDs stay stable)
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
        cell: (info) => info.getValue()?.url ?? <NoneState />,
      }),
    ],
    [columnHelper],
  );

  const { table, filterableColumns, isLoading, error, timing, data } =
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
      enableRowSelection: true,
      rowSelection,
      onRowSelectionChange: setRowSelection,
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
        const entries = await Promise.all(
          data.map(async (recipe) => {
            const recipeIngredients = recipe.sections.flatMap(
              (s) => s.ingredients,
            );
            const totals = await calculateTotals(
              recipeIngredients,
              ingMap,
              getIngredientName,
            );
            return [recipe.id, totals] as const;
          }),
        );

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

  // Get selected rows using the same pattern as ingredients
  const selectedRows = table.getFilteredSelectedRowModel().rows;
  const selectedCount = selectedRows.length;
  const canCompare = selectedCount >= 2 && selectedCount <= 4;

  const handleCompare = () => {
    const ids = selectedRows.map((row) => row.original.id).join(",");
    navigate({ to: "/recipes/compare", search: { ids } });
  };

  return (
    <div>
      <RTable
        table={table}
        filterableColumns={filterableColumns}
        isLoading={isLoading}
        error={error}
        ariaLabel="Recipes Table"
        timing={timing}
        entity="recipe"
        onRowClick={onRowClick}
        additionalToolbarContent={
          selectedCount > 0 ? (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-sm">
                {selectedCount} selected
              </span>
              <Button
                size="sm"
                onClick={handleCompare}
                disabled={!canCompare}
                title={
                  selectedCount < 2
                    ? "Select at least 2 recipes to compare"
                    : selectedCount > 4
                      ? "Select at most 4 recipes to compare"
                      : "Compare selected recipes"
                }
              >
                <Scale className="mr-2 h-4 w-4" />
                Compare
              </Button>
            </div>
          ) : null
        }
      />
      <PreviewSheet />
    </div>
  );
}
