import type { IngredientListItem } from "@cubby/schemas/ingredient-responses";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";
import { Merge, Scale, Sparkles } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { MergeConfirmation } from "~/app/_components/ingredient/merge-confirmation";
import { NoneState } from "~/app/_components/NoneState";
import {
  ProductFoodSummariesProvider,
  useHydratedProductFood,
  useProductFoodSummaries,
} from "~/app/_components/products/product-food-summaries";
import { Row } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { EntityIcon } from "~/entities/entities";
import { getErrorMessage } from "~/lib/error-utils";
import { queryKeys } from "~/lib/query-keys";
import { savedWithRecompute } from "~/lib/recompute-summary";
import { getAllUnitMappingsFromProduct } from "~/lib/unit-mapping-utils";
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

type IngredientProduct = IngredientListItem["product"][number];

/**
 * Product column for the ingredients list. Renders the product pill plus a small
 * USDA apple adornment when the product resolved to a USDA food — a coverage
 * signal so you can triage which ingredients are nutrition/cost-linked without
 * opening each product. The list row stays DB-only; USDA summaries hydrate for
 * the visible nested products after the first table paint.
 */
function ProductPillsCell({ products }: { products: IngredientProduct[] }) {
  return (
    <TruncatedList
      items={products}
      maxItems={1}
      renderItem={(product: IngredientProduct) => (
        <ProductPillWithFood key={product.id} product={product} />
      )}
    />
  );
}

function ProductPillWithFood({ product }: { product: IngredientProduct }) {
  const food = useHydratedProductFood(product);
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <EntityPillLink entity="product" data={product} compact />
      {food ? (
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
            <EntityIcon
              entity="usda-food"
              size={12}
              colored
              aria-label="Linked to USDA food data"
            />
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            USDA: {food.foodInfo.description ?? "linked food"}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </span>
  );
}

/**
 * "Recipes" column cell: the distinct-recipe count up front, followed by a single
 * linked pill for the first recipe. The leading count (not a trailing "+N") is what
 * the column sorts on, so it stays put even as the narrow column clips the pill.
 * `appearsInRecipes` rides on the shared list output — no extra fetch.
 */
function RecipeUsageCell({ ingredient }: { ingredient: IngredientListItem }) {
  const recipes = ingredient.appearsInRecipes;
  if (recipes.length === 0) return <NoneState />;
  return (
    <Row align="center" gap="sm" className="min-w-0">
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
    </Row>
  );
}

export function IngredientList() {
  const missingProductsId = useId();
  const api = useTRPC();
  const trpcClient = useTRPCClient();
  const queryClient = useQueryClient();
  const columnHelper = useMemo(
    () => createColumnHelper<IngredientListItem>(),
    [],
  );
  const { onRowClick, onRowHover, PreviewSheet } =
    useEntityPreview("ingredient");
  const [foodHydrationIds, setFoodHydrationIds] = useState<readonly string[]>(
    [],
  );
  const foodByProductId = useProductFoodSummaries(foodHydrationIds);

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
    invalidateKeys: [queryKeys.ingredient.list],
  });

  const getIngredientListMappings = useCallback(
    (ingredient: IngredientListItem) =>
      ingredient.product.flatMap((product) =>
        getAllUnitMappingsFromProduct({
          ...product,
          food: foodByProductId[product.id] ?? null,
        }),
      ),
    [foodByProductId],
  );

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
    data,
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
    getMappings: getIngredientListMappings,
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
            // The framework doesn't catch onExecute throws (no error toast) and
            // won't reset the target ref, so own both: error-toast on failure and
            // always clear the ref in `finally` (a stale ref would silently pick
            // the wrong keeper on the next merge).
            try {
              const result = await trpcClient.ingredient.merge.mutate({
                target: target.id,
                aliases: aliasRows.map((a) => a.id),
              });
              // The bulk-action framework doesn't auto-invalidate. A merge's blast
              // radius is wide (ingredients deleted, products repointed,
              // Recipe.totals recomputed, meals read those totals), and it's a rare
              // manual action — so blow away the whole cache rather than risk
              // under-invalidating a dependent view.
              void queryClient.invalidateQueries();
              toast.success(
                savedWithRecompute(
                  result.sideEffects,
                  `Merged into ${target.name} (${aliasRows.length} ingredient${aliasRows.length === 1 ? "" : "s"})`,
                ),
              );
              return { success: true };
            } catch (err) {
              toast.error(`Merge failed: ${getErrorMessage(err)}`);
              return { success: false };
            } finally {
              mergeTargetRef.current = null;
            }
          },
        },
      ],
    },
    deletable: deletableConfig,
    infinite: true,
  });

  const productIds = useMemo(
    () => data.flatMap((ingredient) => ingredient.product.map((p) => p.id)),
    [data],
  );
  useEffect(() => {
    const nextIds = [...new Set(productIds)].sort();
    setFoodHydrationIds((currentIds) => {
      if (
        currentIds.length === nextIds.length &&
        currentIds.every((id, index) => id === nextIds[index])
      ) {
        return currentIds;
      }
      return nextIds;
    });
  }, [productIds]);

  return (
    <ProductFoodSummariesProvider
      productIds={productIds}
      summaries={foodByProductId}
    >
      <RTable
        table={table}
        isLoading={isLoading}
        error={error}
        ariaLabel="Ingredients Table"
        timing={timing}
        entity="ingredient"
        onRowClick={onRowClick}
        onRowHover={onRowHover}
        bulkActionBar={bulkActionBar}
        infiniteScroll={infiniteScroll}
        refreshControls={refreshControls}
        actions={
          <Row align="center" gap="sm">
            <Button
              variant="outline"
              render={<Link to="/ingredients/equivalences" />}
              nativeButton={false}
            >
              <Scale className="h-4 w-4" />
              Equivalences
            </Button>
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
          </Row>
        }
        additionalToolbarContent={
          <Row align="center" gap="sm">
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
          </Row>
        }
      />
      <PreviewSheet />
      {deleteDialog}
    </ProductFoodSummariesProvider>
  );
}
