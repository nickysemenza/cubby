import type { LocationType } from "@cubby/schemas/location";
import { getMiscDisplayName, isMiscProduct } from "@cubby/shared";
import type { DataType } from "@cubby/usda-schemas";
import { dataTypeLabel } from "@cubby/usda-schemas";
import { useQuery } from "@tanstack/react-query";
import { sumBy } from "es-toolkit";
import type { ReactNode } from "react";
import { EntityIcon } from "~/entities/entities";
import { isUnspecifiedManufacturer } from "~/lib/manufacturer-utils";
import { dataTypeColor, UsdaDataTypeDot } from "~/lib/usda-data-type";
import { formatCurrency } from "~/lib/utils";
import { useTRPC } from "~/trpc/react";
import { LocationIcon } from "./locations/location-icons";
import {
  type BodyBlock,
  ManifestCard,
  type ManifestCardProps,
  PreviewDeleted,
  PreviewLoading,
  PriceValue,
} from "./preview/manifest-card";
import { formatYield } from "./recipe/recipe-utils";

// Per-entity preview "specs": each toXCard maps a small view-model into the
// declarative ManifestCardProps the shared <ManifestCard> renders. The fetch
// wrappers (*PreviewContent) fetch via tRPC getByID (React-Query cached, only
// mounts while the hovercard is open) and feed the view-model in. The view-model
// types are the shared contract reused by the /design gallery's static samples.

// ── Recipe ──────────────────────────────────────────────────────────────────

export type RecipePreview = {
  id: string;
  name: string;
  yieldText?: string;
  cost?: number;
  calories?: number;
  ingredientCount: number;
  stepCount: number;
  thumbUrl?: string;
};

export function toRecipeCard(vm: RecipePreview): ManifestCardProps {
  const stats: { label: string; value: ReactNode }[] = [];
  if (vm.cost != null)
    stats.push({ label: "Cost", value: formatCurrency(vm.cost) });
  if (vm.calories != null)
    stats.push({ label: "Calories", value: `${Math.round(vm.calories)} kcal` });
  stats.push({ label: "Ingredients", value: vm.ingredientCount });
  if (vm.stepCount > 0) stats.push({ label: "Steps", value: vm.stepCount });

  const body: BodyBlock[] = [];
  if (vm.thumbUrl) body.push({ kind: "thumb", url: vm.thumbUrl });
  body.push({ kind: "stats", stats });

  return {
    entity: "recipe",
    routeParam: vm.id,
    icon: <EntityIcon entity="recipe" size={14} colored />,
    name: vm.name,
    tag: "recipe",
    identity: vm.yieldText,
    crossLinks: [
      {
        to: "/recipes/$id",
        params: { id: vm.id },
        search: { view: "prep" },
        label: "Prep sheet",
      },
    ],
    body,
  };
}

export function RecipePreviewContent({ recipeId }: { recipeId: string }) {
  const trpc = useTRPC();
  const { data, isLoading } = useQuery(
    trpc.recipe.getByID.queryOptions({ id: recipeId }),
  );

  if (isLoading) return <PreviewLoading />;
  if (!data) return <PreviewDeleted label="Recipe" />;

  return (
    <ManifestCard
      {...toRecipeCard({
        id: recipeId,
        name: data.name,
        yieldText: data.yield?.value
          ? `makes ${formatYield(data.yield)}`
          : data.servings
            ? `${data.servings} servings`
            : undefined,
        cost: data.totals?.costTotal,
        calories: data.totals?.caloriesTotal,
        ingredientCount:
          data.totals?.ingredientCount ??
          sumBy(data.sections, (s) => s.ingredients.length),
        stepCount: sumBy(data.sections, (s) => s.instructions.length),
        thumbUrl: data.images[0]?.url,
      })}
    />
  );
}

// ── Ingredient ──────────────────────────────────────────────────────────────

export type IngredientPreview = {
  id: string;
  name: string;
  aliases: string[];
  nutrients?: Record<string, number>;
  cheapestPrice?: number;
  multiplePrices: boolean;
  recipeCount: number;
  usdaFdcId?: number;
  products: { id: string; name: string; manufacturer: string }[];
};

export function toIngredientCard(vm: IngredientPreview): ManifestCardProps {
  const stats: { label: string; value: ReactNode }[] = [];
  if (vm.cheapestPrice != null)
    stats.push({
      label: "Price",
      value: <PriceValue amount={vm.cheapestPrice} from={vm.multiplePrices} />,
    });
  stats.push({ label: "Recipes", value: vm.recipeCount });

  const body: BodyBlock[] = [];
  if (vm.nutrients) body.push({ kind: "nutrients", nutrients: vm.nutrients });
  body.push({ kind: "stats", stats });
  if (vm.products.length > 0)
    body.push({ kind: "products", products: vm.products });

  return {
    entity: "ingredient",
    routeParam: vm.id,
    icon: <EntityIcon entity="ingredient" size={14} colored />,
    name: vm.name,
    tag: "ingredient",
    identity:
      vm.aliases.length > 0 ? `aka ${vm.aliases.join(", ")}` : undefined,
    crossLinks:
      vm.usdaFdcId != null
        ? [
            {
              to: "/usda/$id",
              params: { id: String(vm.usdaFdcId) },
              label: "USDA food",
            },
          ]
        : undefined,
    body,
  };
}

export function IngredientPreviewContent({
  ingredientId,
}: {
  ingredientId: string;
}) {
  const trpc = useTRPC();
  const { data, isLoading } = useQuery(
    trpc.ingredient.getByID.queryOptions({ id: ingredientId }),
  );

  if (isLoading) return <PreviewLoading />;
  if (!data) return <PreviewDeleted label="Ingredient" />;

  const prices = data.product
    .map((prod) => prod.price)
    .filter((v): v is number => v != null);

  return (
    <ManifestCard
      {...toIngredientCard({
        id: ingredientId,
        name: data.name,
        aliases: data.aliases ?? [],
        nutrients: data.product.find((prod) => prod.food?.nutritionInfo)?.food
          ?.nutritionInfo.nutrientsPer100,
        cheapestPrice: prices.length > 0 ? Math.min(...prices) : undefined,
        multiplePrices: prices.length > 1,
        recipeCount: data.appearsInRecipes.length,
        usdaFdcId: data.product.find((prod) => prod.food)?.food?.fdc_id,
        products: data.product.map((prod) => ({
          id: prod.id,
          name: prod.name,
          manufacturer: prod.manufacturer,
        })),
      })}
    />
  );
}

// ── Product ─────────────────────────────────────────────────────────────────

export type ProductPreview = {
  id: string;
  name: string;
  identity?: string;
  nutrients?: Record<string, number>;
  price?: number;
  upc?: string;
  thumbUrl?: string;
  usdaFdcId?: number;
};

export function toProductCard(vm: ProductPreview): ManifestCardProps {
  const body: BodyBlock[] = [];
  if (vm.thumbUrl) body.push({ kind: "thumb", url: vm.thumbUrl });
  if (vm.nutrients) body.push({ kind: "nutrients", nutrients: vm.nutrients });
  const stats: { label: string; value: ReactNode }[] = [];
  if (vm.price != null)
    stats.push({ label: "Price", value: <PriceValue amount={vm.price} /> });
  if (vm.upc)
    stats.push({
      label: "UPC",
      value: <span className="font-mono text-xs">{vm.upc}</span>,
    });
  if (stats.length > 0) body.push({ kind: "stats", stats });

  return {
    entity: "product",
    routeParam: vm.id,
    icon: <EntityIcon entity="product" size={14} colored />,
    name: vm.name,
    tag: "product",
    identity: vm.identity,
    crossLinks:
      vm.usdaFdcId != null
        ? [
            {
              to: "/usda/$id",
              params: { id: String(vm.usdaFdcId) },
              label: "USDA food",
            },
          ]
        : undefined,
    body,
  };
}

export function ProductPreviewContent({ productId }: { productId: string }) {
  const trpc = useTRPC();
  const { data, isLoading } = useQuery(
    trpc.product.getByID.queryOptions({ id: productId }),
  );

  if (isLoading) return <PreviewLoading />;
  if (!data) return <PreviewDeleted label="Product" />;

  const isMisc = isMiscProduct(data.name);
  const manufacturer =
    !isMisc &&
    data.manufacturer &&
    !isUnspecifiedManufacturer(data.manufacturer)
      ? data.manufacturer
      : null;

  return (
    <ManifestCard
      {...toProductCard({
        id: productId,
        name: isMisc ? getMiscDisplayName(data.name) : data.name,
        identity:
          [isMisc ? "misc" : manufacturer, data.category]
            .filter(Boolean)
            .join(" · ") || undefined,
        nutrients: data.food?.nutritionInfo.nutrientsPer100,
        price: data.price ?? undefined,
        upc: data.upc ?? undefined,
        thumbUrl: data.images[0]?.url,
        // Resolved USDA food (explicit fdc_id or UPC-matched) lives on `food`.
        usdaFdcId: data.food?.fdc_id ?? data.fdc_id ?? undefined,
      })}
    />
  );
}

// ── USDA food ───────────────────────────────────────────────────────────────

export type UsdaPreview = {
  fdcId: number;
  name: string;
  dataType?: DataType;
  brand?: string;
  nutrients: Record<string, number>;
  linkedProductId?: string;
};

export function toUsdaCard(vm: UsdaPreview): ManifestCardProps {
  return {
    entity: "usda-food",
    routeParam: String(vm.fdcId),
    icon: vm.dataType ? (
      <EntityIcon
        entity="usda-food"
        size={14}
        style={{ color: dataTypeColor(vm.dataType) }}
      />
    ) : (
      <EntityIcon entity="usda-food" size={14} colored />
    ),
    name: vm.name,
    tag: "usda",
    identity: vm.dataType ? (
      <>
        <UsdaDataTypeDot dataType={vm.dataType} />
        {dataTypeLabel(vm.dataType)}
        {vm.brand && <span>· {vm.brand}</span>}
      </>
    ) : undefined,
    crossLinks: vm.linkedProductId
      ? [
          {
            to: "/products/$id",
            params: { id: vm.linkedProductId },
            label: "Product",
          },
        ]
      : undefined,
    body: [{ kind: "nutrients", nutrients: vm.nutrients }],
  };
}

export function UsdaFoodPreviewContent({ fdcId }: { fdcId: number }) {
  const trpc = useTRPC();
  const { data, isLoading } = useQuery(
    trpc.usda.getByID.queryOptions({ id: fdcId }),
  );

  if (isLoading) return <PreviewLoading />;
  if (!data) return <PreviewDeleted label="Food" />;

  return (
    <ManifestCard
      {...toUsdaCard({
        fdcId,
        name: data.foodInfo.description || "Unnamed Food",
        dataType: data.foodInfo.data_type,
        brand:
          data.brandedFoodInfo?.brand_name ??
          data.brandedFoodInfo?.brand_owner ??
          undefined,
        nutrients: data.nutritionInfo.nutrientsPer100,
        linkedProductId: data.linkedProducts?.[0]?.id,
      })}
    />
  );
}

// ── Location ────────────────────────────────────────────────────────────────

export type LocationPreview = {
  id: string;
  name: string;
  type: LocationType;
  parent?: { id: string; name: string };
  itemCount?: number;
  subCount?: number;
};

export function toLocationCard(vm: LocationPreview): ManifestCardProps {
  const stats: { label: string; value: ReactNode }[] = [];
  if (vm.itemCount != null)
    stats.push({ label: "On hand", value: vm.itemCount });
  if (vm.subCount != null)
    stats.push({ label: "Sub-locations", value: vm.subCount });

  return {
    entity: "location",
    routeParam: vm.id,
    icon: <LocationIcon type={vm.type} size={14} colored />,
    name: vm.name,
    tag: "location",
    identity: (
      <>
        <span>{vm.type}</span>
        {vm.parent && <span>· in {vm.parent.name}</span>}
      </>
    ),
    crossLinks: vm.parent
      ? [
          {
            to: "/locations/$id",
            params: { id: vm.parent.id },
            label: `↑ ${vm.parent.name}`,
          },
        ]
      : undefined,
    body: stats.length > 0 ? [{ kind: "stats", stats }] : undefined,
  };
}

export function LocationPreviewContent({ locationId }: { locationId: string }) {
  const trpc = useTRPC();
  const { data, isLoading } = useQuery(
    trpc.location.getByID.queryOptions({ id: locationId }),
  );

  if (isLoading) return <PreviewLoading />;
  if (!data) return <PreviewDeleted label="Location" />;

  return (
    <ManifestCard
      {...toLocationCard({
        id: locationId,
        name: data.name,
        type: data.type,
        parent: data.parent
          ? { id: data.parent.id, name: data.parent.name }
          : undefined,
        itemCount: data.totalItemCount ?? data.directItemCount ?? undefined,
        subCount: data.childCount ?? data.children?.length ?? undefined,
      })}
    />
  );
}
