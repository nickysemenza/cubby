import type {
  IngredientFilters,
  IngredientListItem,
} from "@cubby/schemas/ingredient";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  createImageColumn,
  createNameColumn,
} from "~/app/_components/data-table/columnHelpers";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  type CubbyColumnCollection,
} from "~/app/_components/data-table/table-features";
import { attachCubbyColumnMeta } from "~/app/_components/data-table/table-meta";
import {
  EntityDisplayImagesProvider,
  useEntityDisplayImage,
} from "~/app/_components/entity-media/entity-display-images";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { EntityInlineLinkList } from "~/app/_components/EntityInlineLinkList";
import { useDeletableConfig } from "~/app/_components/hooks/useDeletableConfig";
import { useUpdateMutation } from "~/app/_components/hooks/useUpdateMutation";
import {
  ProductFoodSummariesProvider,
  useHydratedProductFood,
  useProductFoodSummaries,
} from "~/app/_components/products/product-food-summaries";
import { TruncatedList } from "~/app/_components/TruncatedList";
import { Row } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { NoneValue } from "~/components/ui/none-value";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { EntityIcon } from "~/entities/entities";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import { relationshipFieldProvenance } from "~/entities/field-provenance";
import { getAllUnitMappingsFromProduct } from "~/lib/unit-mapping-utils";

import { useStableIds } from "./stable-ids";
import { defineListOverride } from "./types";

type IngredientProduct = IngredientListItem["product"][number];

const columnHelper = createCubbyColumnHelper<IngredientListItem>();

/**
 * The product pill plus a small USDA adornment when the product resolved to
 * a USDA food — a coverage signal for triaging nutrition/cost links without
 * opening each product. USDA summaries hydrate after the first table paint.
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
  const displayImage = useEntityDisplayImage({
    entityType: "product",
    entityId: product.id,
  });
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <EntityInlineLink
        displayImage={displayImage}
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
 * The distinct-recipe count up front, followed by one linked pill. The
 * leading count is what the column sorts on, so it stays put as the narrow
 * column clips the pill.
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
              <span className="shrink-0 text-xs whitespace-nowrap text-muted-foreground tabular-nums" />
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
        resolveImages={false}
      />
    </Row>
  );
}

export const ingredientListOverride = defineListOverride<
  IngredientListItem,
  IngredientFilters
>({
  use() {
    const [foodHydrationIds, setFoodHydrationIds] = useState<readonly string[]>(
      [],
    );
    const foodByProductId = useProductFoodSummaries(foodHydrationIds);
    const updateIngredientMutation = useUpdateMutation({
      mutationFn: entityMutationOptionsFactory("ingredient", "update"),
      entity: "ingredient",
    });
    const deletable = useDeletableConfig({
      mutationFn: entityMutationOptionsFactory("ingredient", "delete"),
      entityLabel: "Ingredient",
      entity: "ingredient",
    });
    const getMappings = useCallback(
      (ingredient: IngredientListItem) =>
        ingredient.product.flatMap((product) =>
          getAllUnitMappingsFromProduct({
            ...product,
            food: foodByProductId[product.id] ?? null,
          }),
        ),
      [foodByProductId],
    );

    const overrides = useMemo(
      () =>
        createCubbyColumnCollection<IngredientListItem>((add) => {
          add(
            createNameColumn(columnHelper, "ingredient", "name", {
              // Capped so the flex space goes to Recipes + Product, whose
              // content benefits from it.
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
          );
          add(
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
          );
          add(
            columnHelper.accessor("usuallyOnHand", {
              header: "Usually on hand",
              meta: {
                className: "w-36",
                mobile: { slot: "meta", priority: 25 },
              },
              cell: (info) =>
                info.getValue() ? (
                  <Badge variant="secondary">Usually on hand</Badge>
                ) : (
                  <NoneValue />
                ),
            }),
          );
        }),
      // oxlint-disable-next-line react/exhaustive-deps -- updateIngredientMutation changes every render but is functionally stable
      [],
    );

    const compose = useMemo(
      () => (declared: CubbyColumnCollection<IngredientListItem>) =>
        createCubbyColumnCollection<IngredientListItem>((add) => {
          add(createImageColumn(columnHelper, { entity: "ingredient" }));
          declared.visit(add);
          add(
            columnHelper.accessor("appearsInRecipes", {
              id: "appearsInRecipes",
              header: "Recipes",
              meta: attachCubbyColumnMeta<IngredientListItem>({
                provenance: relationshipFieldProvenance(
                  "ingredient",
                  "recipes",
                ),
                className: "w-56 overflow-hidden",
                mobile: { slot: "meta", priority: 30 },
                entityRefs: (row) =>
                  row.appearsInRecipes.map((recipe) => ({
                    entityType: "recipe",
                    entityId: recipe.id,
                  })),
              }),
              cell: (info) => (
                <RecipeUsageCell ingredient={info.row.original} />
              ),
            }),
          );
          add(
            columnHelper.accessor("product", {
              id: "product",
              header: "Product",
              meta: {
                provenance: relationshipFieldProvenance(
                  "ingredient",
                  "products",
                ),
                className: "w-72 overflow-hidden",
                mobile: { slot: "subtitle", priority: 10 },
              },
              cell: (info) => (
                <ProductPillsCell products={info.getValue() ?? []} />
              ),
            }),
          );
        }),
      [],
    );

    const list = useMemo(
      () => ({ deletable, getMappings }),
      [deletable, getMappings],
    );

    return {
      overrides,
      compose,
      list,
      wrap: (children, { data }) => (
        <IngredientFoodHydration
          data={data}
          summaries={foodByProductId}
          onIds={setFoodHydrationIds}
        >
          {children}
        </IngredientFoodHydration>
      ),
    };
  },
});

function IngredientFoodHydration({
  data,
  summaries,
  onIds,
  children,
}: {
  data: IngredientListItem[];
  summaries: ReturnType<typeof useProductFoodSummaries>;
  onIds: (ids: readonly string[]) => void;
  children: ReactNode;
}) {
  const productIds = useMemo(
    () => data.flatMap((ingredient) => ingredient.product.map((p) => p.id)),
    [data],
  );
  const stableIds = useStableIds(productIds);
  useEffect(() => onIds(stableIds), [onIds, stableIds]);
  return (
    <ProductFoodSummariesProvider productIds={productIds} summaries={summaries}>
      <EntityDisplayImagesProvider
        refs={productIds.map((entityId) => ({
          entityType: "product" as const,
          entityId,
        }))}
      >
        {children}
      </EntityDisplayImagesProvider>
    </ProductFoodSummariesProvider>
  );
}
