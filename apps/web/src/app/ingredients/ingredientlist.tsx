import {
  type IngredientListItem,
  ingredientCoverImage,
} from "@cubby/schemas/ingredient";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { uniq } from "es-toolkit";
import { Scale, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createCubbyColumnHelper } from "~/app/_components/data-table/table-features";
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
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import { entityListFor } from "~/entities/entity-list.functions";
import { getAllUnitMappingsFromProduct } from "~/lib/unit-mapping-utils";
import {
  createImageColumn,
  createNameColumn,
} from "../_components/data-table/columnHelpers";
import { ListWorkbench } from "../_components/data-table/ListWorkbench";
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
  const columnHelper = useMemo(
    () => createCubbyColumnHelper<IngredientListItem>(),
    [],
  );
  const {
    onRowClick,
    inspectRow,
    onRowHover,
    onRowHoverEnd,
    PreviewSheet,
    preview,
    dockedInspector,
    inspectorToggle,
  } = useEntityPreview("ingredient", { responsiveInspector: true });
  const [foodHydrationIds, setFoodHydrationIds] = useState<readonly string[]>(
    [],
  );
  const foodByProductId = useProductFoodSummaries(foodHydrationIds);

  // Mutation for inline editing (name)
  const updateIngredientMutation = useUpdateMutation({
    mutationFn: entityMutationOptionsFactory("ingredient", "update"),
    entity: "ingredient",
  });

  // Count of stub ingredients (no products) to surface the enrichment entry point.
  const { data: stubData } = useQuery(
    entityListFor("ingredient").queryOptions({
      filters: { productPresenceFilter: "none" },
      pagination: { pageIndex: 0, pageSize: 1 },
    }),
  );
  const stubCount = stubData?.meta.totalCount ?? 0;

  // Memoize deletable config to prevent infinite render loop
  const deletableConfig = useDeletableConfig({
    mutationFn: entityMutationOptionsFactory("ingredient", "delete"),
    entityLabel: "Ingredient",
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
      createImageColumn(columnHelper, {
        entity: "ingredient",
        // An ingredient has no images of its own, so this borrows the photo of
        // a product it maps to — the images are already joined for the Product
        // column's pill. Without it every row rendered the carrot placeholder.
        getImages: (ingredient) => {
          const cover = ingredientCoverImage(ingredient);
          return cover ? [cover] : [];
        },
      }),
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

  const { workbench, data, totalCount } = useEntityList({
    entity: "ingredient",
    onInspectRow: inspectRow,
    getMappings: getIngredientListMappings,
    columns,
    deletable: deletableConfig,
  });
  usePageCount(totalCount);

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
      <ListWorkbench
        model={workbench}
        ariaLabel="Ingredients Table"
        onRowClick={onRowClick}
        onRowHover={onRowHover}
        onRowHoverEnd={onRowHoverEnd}
        currentRowId={preview?.id}
        desktopInspector={dockedInspector}
        inspectorToggle={inspectorToggle}
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
    </ProductFoodSummariesProvider>
  );
}
