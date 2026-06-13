import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";
import { Check, Merge, Sparkles } from "lucide-react";
import {
  type RefObject,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
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
import { cn } from "~/lib/utils";
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

/**
 * Merge confirmation body. Holds its own selected-target state so the radios
 * re-render on click (the bulk-action dialog doesn't re-render on parent state
 * changes), and mirrors the choice into `targetRef` so `onExecute` — which can't
 * read this component's state — picks the right keeper.
 */
function MergeConfirmation({
  ingredients,
  targetRef,
}: {
  ingredients: Array<{ id: string; name: string }>;
  targetRef: RefObject<string | null>;
}) {
  const [targetId, setTargetId] = useState<string>(
    () => ingredients[0]?.id ?? "",
  );
  useEffect(() => {
    targetRef.current = targetId;
  }, [targetId, targetRef]);

  const aliases = ingredients.filter((i) => i.id !== targetId);
  return (
    <div className="space-y-3">
      <div>
        <div className="mb-1 font-medium text-muted-foreground text-sm">
          Keep (target):
        </div>
        <div className="flex flex-col gap-1">
          {ingredients.map((ing) => {
            const selected = ing.id === targetId;
            return (
              <Button
                key={ing.id}
                type="button"
                variant={selected ? "default" : "outline"}
                size="sm"
                className="justify-start"
                onClick={() => setTargetId(ing.id)}
              >
                <Check
                  className={cn(
                    "h-4 w-4 shrink-0",
                    selected ? "opacity-100" : "opacity-0",
                  )}
                />
                <span className="truncate">{ing.name}</span>
              </Button>
            );
          })}
        </div>
      </div>
      <div>
        <div className="mb-1 font-medium text-muted-foreground text-sm">
          Merge into aliases:
        </div>
        <div className="flex flex-wrap gap-1">
          {aliases.length > 0 ? (
            aliases.map((a) => (
              <EntityPillLink
                key={a.id}
                entity="ingredient"
                data={{ name: a.name, id: a.id }}
              />
            ))
          ) : (
            <NoneState />
          )}
        </div>
      </div>
      <p className="text-muted-foreground text-xs">
        The other selected ingredient{aliases.length === 1 ? "" : "s"} will be
        deleted — their names become aliases of the kept one, and their products
        and recipe uses move over.
      </p>
    </div>
  );
}

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
 * "Recipes" column cell: the deduped recipe pills (as before) plus a muted total-
 * usage count when the ingredient is used more times than it has distinct recipes
 * (i.e. it appears in multiple sections of the same recipe). `recipeUsages` and the
 * derived `appearsInRecipes` both ride on the shared list output — no extra fetch.
 */
function RecipeUsageCell({
  ingredient,
}: {
  ingredient: IngredientWithFoodOut;
}) {
  const recipes = ingredient.appearsInRecipes;
  const totalUses = ingredient.recipeUsages.length;
  // Lead with the count so it survives the narrow column's overflow clipping;
  // the pills' own "+N" already conveys recipe breadth, so only show when an
  // ingredient is used more times than it has distinct recipes (multi-section).
  return (
    <div className="flex min-w-0 items-center gap-1">
      {totalUses > recipes.length && (
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="shrink-0 whitespace-nowrap text-muted-foreground text-xs tabular-nums" />
            }
          >
            {totalUses}×
          </TooltipTrigger>
          <TooltipContent>
            {totalUses} uses across {recipes.length} recipe
            {recipes.length === 1 ? "" : "s"}
          </TooltipContent>
        </Tooltip>
      )}
      <EntityPillLinkList
        entity="recipe"
        items={recipes}
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
      columnHelper.display({
        id: "appearsInRecipes",
        header: "Recipes",
        meta: {
          className: "w-48 max-w-48 overflow-hidden",
          mobile: { slot: "meta", priority: 30 },
        },
        cell: (info) => <RecipeUsageCell ingredient={info.row.original} />,
      }),
      columnHelper.accessor("product", {
        id: "product",
        header: "Product",
        enableSorting: false,
        meta: {
          className: "w-48 max-w-48 overflow-hidden",
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
                render={<Link to="/ingredients/enrich" />}
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
