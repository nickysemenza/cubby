import type { IngredientListItem } from "@cubby/schemas/ingredient";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { uniq } from "es-toolkit";
import { Scale, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { verbBulkAction } from "~/app/_components/actions/action-verb-ui";
import { createCubbyColumnHelper } from "~/app/_components/data-table/table-features";
import { IngredientMergeDialog } from "~/app/_components/ingredient/ingredient-merge-dialog";
import {
  ProductFoodSummariesProvider,
  useHydratedProductFood,
  useProductFoodSummaries,
} from "~/app/_components/products/product-food-summaries";
import { Row } from "~/components/layout";
import { usePageCount } from "~/components/page/Page";
import { Button } from "~/components/ui/button";
import { NoneValue } from "~/components/ui/none-value";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { EntityIcon } from "~/entities/entities";
import { useTRPC, useTRPCClient } from "~/integrations/trpc/react";
import { getErrorMessage } from "~/lib/error-utils";
import {
  ingredientMergeMutationInvalidateKeys,
  ingredientMutationInvalidateKeys,
  invalidateTRPCQueries,
} from "~/lib/query-keys";
import { savedWithBackgroundWork } from "~/lib/recompute-summary";
import { getAllUnitMappingsFromProduct } from "~/lib/unit-mapping-utils";
import {
  createImageColumn,
  createNameColumn,
} from "../_components/data-table/columnHelpers";
import RTable from "../_components/data-table/Table";
import { EntityInlineLink } from "../_components/EntityInlineLink";
import { EntityInlineLinkList } from "../_components/EntityInlineLinkList";
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
      <EntityInlineLink
        displayImage={undefined}
        entity="product"
        data={product}
        compact
      />
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
  if (recipes.length === 0) return <NoneValue />;
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
      <EntityInlineLinkList
        entity="recipe"
        items={recipes.slice(0, 1)}
        maxItems={1}
        compact
      />
    </Row>
  );
}

export function IngredientList() {
  const api = useTRPC();
  const trpcClient = useTRPCClient();
  const queryClient = useQueryClient();
  const columnHelper = useMemo(
    () => createCubbyColumnHelper<IngredientListItem>(),
    [],
  );
  const { onRowClick, onRowHover, PreviewSheet } =
    useEntityPreview("ingredient");
  const [foodHydrationIds, setFoodHydrationIds] = useState<readonly string[]>(
    [],
  );
  const foodByProductId = useProductFoodSummaries(foodHydrationIds);

  // Mutation for inline editing (name)
  const updateIngredientMutation = useUpdateMutation({
    mutationFn: api.ingredient.update.mutationOptions,
    entity: "ingredient",
    invalidateKeys: ingredientMutationInvalidateKeys,
  });

  // Rows awaiting merge confirmation — set by the bulk action's onExecute
  // (which itself does no work; it just opens the dialog), cleared once the
  // shared IngredientMergeDialog's onConfirm/cancel resolves.
  const [mergeRows, setMergeRows] = useState<
    Pick<IngredientListItem, "id" | "name">[] | null
  >(null);
  const [mergePending, setMergePending] = useState(false);

  // Count of stub ingredients (no products) to surface the enrichment entry point.
  const { data: stubData } = useQuery(
    api.ingredient.list.queryOptions({
      filters: { productPresenceFilter: "none" },
      pagination: { pageIndex: 0, pageSize: 1 },
    }),
  );
  const stubCount = stubData?.meta.totalCount ?? 0;

  // Memoize deletable config to prevent infinite render loop
  const deletableConfig = useDeletableConfig({
    mutationFn: api.ingredient.delete.mutationOptions,
    entityLabel: "Ingredient",
    invalidateKeys: ingredientMutationInvalidateKeys,
    entity: "ingredient",
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
    totalCount,
  } = useEntityList({
    entity: "ingredient",
    queryOptions: api.ingredient.list.queryOptions,
    getMappings: getIngredientListMappings,
    columns,
    bulkActions: {
      actions: [
        verbBulkAction<IngredientListItem>("merge", {
          minSelection: 2,
          // No built-in confirmation: `onExecute` only opens the shared
          // IngredientMergeDialog (below) and returns `success: false` so the
          // framework leaves the row selection alone while it's open. The
          // dialog's own Confirm button does the actual merge via
          // `confirmMerge`.
          onExecute: async (rows) => {
            setMergeRows(rows.map((r) => r.original));
            return { success: false };
          },
        }),
      ],
    },
    deletable: deletableConfig,
  });
  usePageCount(totalCount);

  // Runs the merge the shared dialog confirmed. The bulk-action framework
  // doesn't auto-invalidate or clear selection for a `success: false`
  // onExecute (deliberate — see above), so both are handled here.
  const confirmMerge = async (keepId: string, aliasIds: string[]) => {
    const targetName =
      mergeRows?.find((i) => i.id === keepId)?.name ?? "ingredient";
    setMergePending(true);
    try {
      const result = await trpcClient.ingredient.merge.mutate({
        target: keepId,
        aliases: aliasIds,
      });
      // A merge's blast radius is wide: ingredients are deleted, products
      // repoint, recipe totals are recomputed, and meals read those totals.
      invalidateTRPCQueries(queryClient, ingredientMergeMutationInvalidateKeys);
      toast.success(
        savedWithBackgroundWork(
          result.sideEffects,
          `Merged into ${targetName} (${aliasIds.length} ingredient${aliasIds.length === 1 ? "" : "s"})`,
        ),
      );
      table.resetRowSelection();
      setMergeRows(null);
    } catch (err) {
      toast.error(`Merge failed: ${getErrorMessage(err)}`);
    } finally {
      setMergePending(false);
    }
  };

  const productIds = useMemo(
    () => data.flatMap((ingredient) => ingredient.product.map((p) => p.id)),
    [data],
  );
  useEffect(() => {
    const nextIds = uniq(productIds).sort();
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
              <Scale className="size-4" />
              Equivalences
            </Button>
            {stubCount > 0 && (
              <Button
                variant="outline"
                render={<Link to="/ingredients/workbench" />}
                nativeButton={false}
              >
                <Sparkles className="size-4" />
                Enrich {stubCount} stub{stubCount === 1 ? "" : "s"}
              </Button>
            )}
            <Button
              variant="default"
              render={<Link to="/ingredients/new" />}
              nativeButton={false}
            >
              New
            </Button>
          </Row>
        }
      />
      <PreviewSheet />
      {deleteDialog}
      <IngredientMergeDialog
        ingredients={mergeRows ?? []}
        open={mergeRows != null}
        onOpenChange={(open) => {
          if (!open) setMergeRows(null);
        }}
        onConfirm={confirmMerge}
        isPending={mergePending}
      />
    </ProductFoodSummariesProvider>
  );
}
