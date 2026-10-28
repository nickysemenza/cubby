import { type IngredientListItemOut as IngredientListItem } from "@cubby/schemas/entities/ingredient";
import { fieldValueOf } from "@cubby/schemas/field-envelope";
import type { IngredientFilters } from "@cubby/schemas/ingredient";
import { useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  EntityRefLink,
  EntityRefList,
} from "~/entity/components/entity-ref-link";
import { EntityIcon } from "~/entity/entities";
import { entityMutationOptionsFactory } from "~/entity/entity-contracts";
import {
  EntityDisplayImagesProvider,
  useEntityDisplayImage,
} from "~/entity/entity-media/entity-display-images";
import { relationshipFieldProvenance } from "~/entity/fields/field-provenance";
import { useDeletableConfig } from "~/entity/hooks/use-deletable-config";
import {
  ProductFoodSummariesProvider,
  useHydratedProductFood,
  useProductFoodSummaries,
} from "~/features/product/product-food-summaries";
import { getAllUnitMappingsFromProduct } from "~/lib/unit-mapping-utils";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  type CubbyColumnCollection,
} from "~/ui/data-table/table-features";
import { attachCubbyColumnMeta } from "~/ui/data-table/table-meta";
import { Row } from "~/ui/layout";
import { NoneValue } from "~/ui/primitives/none-value";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/ui/primitives/tooltip";
import { TruncatedList } from "~/ui/truncated-list";

import { useStableIds } from "../../entity/list-columns/stable-ids";
import { defineListOverride } from "../../entity/list-columns/types";

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
    entityKind: "product",
    entityId: product.id,
  });
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <EntityRefLink
        displayImage={displayImage}
        entity="product"
        data={product}
      />
      {food ? (
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
            <EntityIcon
              entity="usda-food"
              size={12}
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
      <EntityRefList
        entity="recipe"
        items={recipes.slice(0, 1)}
        maxItems={1}
        compact
        resolveImages={false}
      />
    </Row>
  );
}

export const ingredientListOverride = defineListOverride<IngredientFilters>({
  use() {
    const queryClient = useQueryClient();
    const [foodHydrationIds, setFoodHydrationIds] = useState<readonly string[]>(
      [],
    );
    const foodByProductId = useProductFoodSummaries(foodHydrationIds);
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
            price: fieldValueOf(product.fields.price),
            food: foodByProductId[product.id] ?? null,
          }),
        ),
      [foodByProductId],
    );

    const compose = useMemo(
      () => (declared: CubbyColumnCollection<IngredientListItem>) =>
        createCubbyColumnCollection<IngredientListItem>((add) => {
          declared.visit(add);
          add(
            columnHelper.accessor("appearsInRecipes", {
              id: "appearsInRecipes",
              header: "Recipes",
              meta: attachCubbyColumnMeta<IngredientListItem>({
                columnGroup: "Use",
                provenance: relationshipFieldProvenance(
                  queryClient,
                  "ingredient",
                  "recipes",
                ),
                className: "w-56 overflow-hidden",
                mobile: { slot: "meta", priority: 30 },
                entityRefs: (row) =>
                  row.appearsInRecipes.map((recipe) => ({
                    entityKind: "recipe",
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
                columnGroup: "Catalog",
                provenance: relationshipFieldProvenance(
                  queryClient,
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
      [queryClient],
    );

    const list = useMemo(
      () => ({ deletable, getMappings }),
      [deletable, getMappings],
    );

    return {
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
          entityKind: "product" as const,
          entityId,
        }))}
      >
        {children}
      </EntityDisplayImagesProvider>
    </ProductFoodSummariesProvider>
  );
}
