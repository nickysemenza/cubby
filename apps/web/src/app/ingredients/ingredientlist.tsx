import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";
import { Merge, Sparkles } from "lucide-react";
import { useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { MergeConfirmation } from "~/app/_components/ingredient/merge-confirmation";
import { NoneState } from "~/app/_components/NoneState";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { EntityIcon } from "~/entities/entities";
import { queryKeys } from "~/lib/query-keys";
import { getIngredientMappings } from "~/lib/unit-mapping-utils";
import type { IngredientWithFoodOut } from "~/server/services/ingredient.service";
import { useTRPC, useTRPCClient } from "~/trpc/react";
import {
  createCreatedAtColumn,
  createImageColumn,
  createNameColumn,
} from "../_components/data-table/columnHelpers";
import RTable from "../_components/data-table/Table";
import { EntityPillLink } from "../_components/EntityPill";
import { EntityPillLinkList } from "../_components/EntityPillLinkList";
import { useDeletableConfig } from "../_components/hooks/useDeletableConfig";
import { useEntityList } from "../_components/hooks/useEntityList";
import { useEntityPreview } from "../_components/hooks/useEntityPreview";
import { useUpdateMutation } from "../_components/hooks/useUpdateMutation";
import { TruncatedList } from "../_components/TruncatedList";

type IngredientProduct = IngredientWithFoodOut["product"][number];

/**
 * Product column for the ingredients list. Renders the product pill plus a small
 * USDA apple adornment when the product resolved to a USDA food — a coverage
 * signal so you can triage which ingredients are nutrition/cost-linked without
 * opening each product. `food` is already batch-enriched on the list query
 * (IngredientService.ingredientList), so this is free of extra fetches.
 */
function ProductPillsCell({ products }: { products: IngredientProduct[] }) {
  return (
    <TruncatedList
      items={products}
      maxItems={1}
      renderItem={(product: IngredientProduct) => (
        <span
          key={product.id}
          className="inline-flex min-w-0 items-center gap-1"
        >
          <EntityPillLink entity="product" data={product} compact />
          {product.food ? (
            <Tooltip>
              <TooltipTrigger
                render={<span className="inline-flex shrink-0" />}
              >
                <EntityIcon
                  entity="usda-food"
                  size={12}
                  colored
                  aria-label="Linked to USDA food data"
                />
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                USDA: {product.food.foodInfo.description ?? "linked food"}
              </TooltipContent>
            </Tooltip>
          ) : null}
        </span>
      )}
    />
  );
}

/**
 * "Recipes" column cell: the distinct-recipe count up front, followed by a single
 * linked pill for the first recipe. The leading count (not a trailing "+N") is what
 * the column sorts on, so it stays put even as the narrow column clips the pill.
 * `appearsInRecipes` rides on the shared list output — no extra fetch.
 */
function RecipeUsageCell({
  ingredient,
}: {
  ingredient: IngredientWithFoodOut;
}) {
  const recipes = ingredient.appearsInRecipes;
  if (recipes.length === 0) return <NoneState />;
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {recipes.length > 1 && (
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="shrink-0 whitespace-nowrap text-muted-foreground text-xs tabular-nums" />
            }
          >
            {recipes.length}
          </TooltipTrigger>
          <TooltipContent>Appears in {recipes.length} recipes</TooltipContent>
        </Tooltip>
      )}
      <EntityPillLinkList
        entity="recipe"
        items={recipes.slice(0, 1)}
        maxItems={1}
        compact
      />
    </div>
  );
}

export function IngredientList() {
  const missingProductsId = useId();
  const api = useTRPC();
  const trpcClient = useTRPCClient();
  const columnHelper = useMemo(
    () => createColumnHelper<IngredientWithFoodOut>(),
    [],
  );
  const { onRowClick, PreviewSheet } = useEntityPreview("ingredient");

  // Memoize invalidate keys to prevent recreating on every render
  const invalidateKeys = useMemo(
    () => [queryKeys.ingredient.list] as const,
    [],
  );

  // Mutation for inline editing (name)
  const updateIngredientMutation = useUpdateMutation({
    mutationFn: api.ingredient.update.mutationOptions,
    entity: "ingredient",
    invalidateKeys,
  });

  // Global filter for missing products
  const [globalFilter, setGlobalFilter] = useState({
    missingProductsOnly: false,
  });

  // Which selected ingredient to keep when merging. A ref (not state) so the
  // bulk-action onExecute reads the latest choice without a stale closure.
  const mergeTargetRef = useRef<string | null>(null);

  // Count of stub ingredients (no products) to surface the enrichment entry point.
  const { data: stubData } = useQuery(
    api.ingredient.list.queryOptions({
      filters: { missingProductsOnly: true },
      pagination: { pageIndex: 0, pageSize: 1 },
    }),
  );
  const stubCount = stubData?.meta.totalCount ?? 0;

  // Memoize deletable config to prevent infinite render loop
  const deletableConfig = useDeletableConfig({
    mutationFn: api.ingredient.delete.mutationOptions,
    entityLabel: "Ingredient",
    invalidateKeys: [[queryKeys.ingredient.list]],
  });

  // Memoize columns to prevent recreating on every render
  // Note: updateIngredientMutation is NOT in dependencies because useMutation returns a new object every render
  // biome-ignore lint/correctness/useExhaustiveDependencies: updateIngredientMutation changes every render but is functionally stable
  const columns = useMemo(
    () => [
      createImageColumn(columnHelper, { entity: "ingredient" }),
      createNameColumn(columnHelper, "ingredient", "name", {
        // Cap the name (it would otherwise absorb all leftover width under the
        // fixed layout and leave a big gap); the flex space goes to Recipes +
        // Product below, whose content actually benefits from it.
        className: "w-56",
        filterConfig: { placeholder: "Filter by ingredient name..." },
        editable: {
          onSave: async (newName, ingredient) => {
            await updateIngredientMutation.mutateAsync({
              id: ingredient.id,
              data: { name: newName },
            });
          },
        },
      }),
      columnHelper.accessor("aliases", {
        header: "Aliases",
        meta: {
          className: "w-48",
          mobile: { slot: "subtitle", priority: 20 },
        },
        cell: (info) => (
          <TruncatedList
            items={info.getValue()}
            maxItems={2}
            renderItem={(alias: string) => (
              <span key={alias} className="truncate text-xs">
                {alias}
              </span>
            )}
          />
        ),
      }),
      createCreatedAtColumn(columnHelper),
      columnHelper.accessor("appearsInRecipes", {
        id: "appearsInRecipes",
        header: "Recipes",
        meta: {
          // Generous fixed widths on the content-rich columns (vs the old w-48):
          // under the fixed layout all columns scale proportionally, so giving
          // Recipes/Product more weight than Name steers leftover space here
          // instead of into a ballooning Name column.
          className: "w-56 overflow-hidden",
          mobile: { slot: "meta", priority: 30 },
        },
        cell: (info) => <RecipeUsageCell ingredient={info.row.original} />,
      }),
      columnHelper.accessor("product", {
        id: "product",
        header: "Product",
        meta: {
          className: "w-72 overflow-hidden",
          mobile: { slot: "subtitle", priority: 10 },
        },
        cell: (info) => <ProductPillsCell products={info.getValue() ?? []} />,
      }),
    ],
    [columnHelper],
  );

  const {
    table,
    isLoading,
    error,
    timing,
    bulkActionBar,
    deleteDialog,
    infiniteScroll,
    refreshControls,
  } = useEntityList({
    entity: "ingredient",
    queryOptions: api.ingredient.list.queryOptions,
    buildFilters: (ts) => ({
      nameFilter: ts.getColumnFilter("name"),
      missingProductsOnly: globalFilter.missingProductsOnly,
    }),
    getMappings: getIngredientMappings,
    columns,
    filters: [{ id: "name", placeholder: "Filter by ingredient name..." }],
    globalFilter,
    onGlobalFilterChange: setGlobalFilter as (value: unknown) => void,
    bulkActions: {
      actions: [
        {
          id: "merge",
          label: "Merge",
          icon: <Merge className="h-4 w-4" />,
          minSelection: 2,
          requiresConfirmation: true,
          renderConfirmation: (rows) => (
            <MergeConfirmation
              ingredients={rows.map((r) => r.original)}
              targetRef={mergeTargetRef}
            />
          ),
          onExecute: async (rows) => {
            const ingredients = rows.map((r) => r.original);
            const chosen = mergeTargetRef.current;
            const targetId =
              chosen && ingredients.some((i) => i.id === chosen)
                ? chosen
                : ingredients[0]?.id;
            const target = ingredients.find((i) => i.id === targetId);
            if (!target) return { success: false };
            const aliasRows = ingredients.filter((i) => i.id !== target.id);
            await trpcClient.ingredient.merge.mutate({
              target: target.id,
              aliases: aliasRows.map((a) => a.id),
            });
            toast.success(
              `Merged into ${target.name} (${aliasRows.length} ingredient${aliasRows.length === 1 ? "" : "s"})`,
            );
            mergeTargetRef.current = null;
            return { success: true };
          },
        },
      ],
    },
    deletable: deletableConfig,
    infinite: true,
  });

  return (
    <div>
      <RTable
        table={table}
        isLoading={isLoading}
        error={error}
        ariaLabel="Ingredients Table"
        timing={timing}
        entity="ingredient"
        onRowClick={onRowClick}
        bulkActionBar={bulkActionBar}
        infiniteScroll={infiniteScroll}
        refreshControls={refreshControls}
        actions={
          <div className="flex items-center gap-2">
            {stubCount > 0 && (
              <Button
                variant="outline"
                render={<Link to="/ingredients/workbench" />}
                nativeButton={false}
              >
                <Sparkles className="h-4 w-4" />
                Enrich {stubCount} stub{stubCount === 1 ? "" : "s"}
              </Button>
            )}
            <Button
              variant="default"
              render={<Link to="/ingredients/new" />}
              nativeButton={false}
            >
              Create New Ingredient
            </Button>
          </div>
        }
        additionalToolbarContent={
          <div className="flex items-center space-x-2">
            <Checkbox
              id={missingProductsId}
              checked={table.getState().globalFilter.missingProductsOnly}
              onCheckedChange={(checked) =>
                table.setGlobalFilter({ missingProductsOnly: checked })
              }
            />
            <label
              htmlFor={missingProductsId}
              className="font-medium text-sm leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
            >
              Missing Products Only
            </label>
          </div>
        }
      />
      <PreviewSheet />
      {deleteDialog}
    </div>
  );
}
