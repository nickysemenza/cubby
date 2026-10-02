import type {
  IngredientFilters,
  IngredientListItem,
} from "@cubby/schemas/ingredient";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { EntityIcon } from "~/entity/entities";
import { entityMutationOptionsFactory } from "~/entity/entity-contracts";
import {
  EntityDisplayImagesProvider,
  useEntityDisplayImage,
} from "~/entity/entity-media/entity-display-images";
import { relationshipFieldProvenance } from "~/entity/field-provenance";
import {
  ProductFoodSummariesProvider,
  useHydratedProductFood,
  useProductFoodSummaries,
} from "~/features/products/product-food-summaries";
import { getAllUnitMappingsFromProduct } from "~/lib/unit-mapping-utils";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  type CubbyColumnCollection,
} from "~/ui/data-table/table-features";
import { attachCubbyColumnMeta } from "~/ui/data-table/table-meta";
import { useDeletableConfig } from "~/ui/hooks/useDeletableConfig";
import { Row } from "~/ui/layout";
import { NoneValue } from "~/ui/primitives/none-value";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/ui/primitives/tooltip";
import { TruncatedList } from "~/ui/TruncatedList";

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
    entityKind: "product",
    entityId: product.id,
  });
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <EntityRefLink
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
      <EntityRefLink
        variant="list"
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

    const compose = useMemo(
      () => (declared: CubbyColumnCollection<IngredientListItem>) =>
        createCubbyColumnCollection<IngredientListItem>((add) => {
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
      () => ({ deletable, getMappings, mappingsReadFields: ["product"] }),
      [deletable, getMappings],
    );

    return {
      compose,
      list,
      wrapReadFields: ["product"],
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
