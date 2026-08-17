import { isDisplayableImageFile } from "@cubby/schemas/image";
import {
  type LocationIdentityProductOut,
  type LocationType,
  locationCoverImage,
} from "@cubby/schemas/location";
import type {
  CostType,
  ProjectKind,
  ProjectStatus,
  TaskStatus,
  Trade,
} from "@cubby/schemas/project";
import { RECIPE_MACRO_KEYS } from "@cubby/schemas/recipe-shared";
import { getMiscDisplayName, isMiscProduct } from "@cubby/shared";
import type { DataType, NutrientKey } from "@cubby/usda-schemas";
import { buildNutrients, dataTypeLabel } from "@cubby/usda-schemas";
import { useQuery } from "@tanstack/react-query";
import { sumBy } from "es-toolkit";
import { ListChecks } from "lucide-react";
import type { ReactNode } from "react";
import { match } from "ts-pattern";
import { OrderIdLink } from "~/app/_components/OrderIdLink";
import { costTypeLabels } from "~/app/expenses/expense-options";
import {
  capitalize,
  formatDate,
  formatDateRange,
  PROJECT_STATUS_LABELS,
  TRADE_LABELS,
} from "~/app/projects/project-formatting";
import { ProjectMark, ProjectMarkById } from "~/app/projects/project-mark";
import { TASK_STATUS_LABELS } from "~/app/tasks/task-options";
import { Row } from "~/components/layout";
import { EntityIcon } from "~/entities/entities";
import { fdcIdFromParam } from "~/entities/entity-query";
import { useTRPC } from "~/integrations/trpc/react";
import { isUnspecifiedManufacturer } from "~/lib/manufacturer-utils";
import { purchaseLabel } from "~/lib/purchase-label";
import { dataTypeColor, UsdaDataTypeDot } from "~/lib/usda-data-type";
import { formatCurrency } from "~/lib/utils";
import { tryFormatAmount } from "./inventory/format-amount";
import { LocationIcon } from "./locations/location-icons";
import {
  type BodyBlock,
  type CrossLink,
  ManifestCard,
  type ManifestCardProps,
  PriceValue,
} from "./preview/manifest-card";
import type { HoverPreviewEntity } from "./preview/preview-entities";
import { PreviewQuery } from "./preview/preview-query";
import { coverageLabel, formatYield } from "./recipe/recipe-utils";

// Cross-link to the USDA food behind an ingredient/product (built identically
// for both). The food description is too long to use as the label, so the
// apple icon + type label carry it.
const usdaCrossLink = (fdcId: number): CrossLink => ({
  to: "/usda/$id",
  params: { id: String(fdcId) },
  icon: <EntityIcon entity="usda-food" size={12} colored />,
  label: "USDA food",
});

// Per-entity preview "specs": each toXCard maps a small view-model into the
// declarative ManifestCardProps the shared <ManifestCard> renders. The fetch
// wrappers (*PreviewContent) fetch via tRPC getByID (React-Query cached, only
// mounts while the hovercard is open) and feed the view-model in. The view-model
// Shared preview contracts keep hover-card renderers aligned across entities.

export function EntityPreviewContent({
  entity,
  id,
}: {
  entity: HoverPreviewEntity;
  id: string;
}) {
  return match(entity)
    .with("recipe", () => <RecipePreviewContent recipeId={id} />)
    .with("ingredient", () => <IngredientPreviewContent ingredientId={id} />)
    .with("product", () => <ProductPreviewContent productId={id} />)
    .with("usda-food", () => (
      <UsdaFoodPreviewContent fdcId={fdcIdFromParam(id)} />
    ))
    .with("cookbook", () => <CookbookPreviewContent cookbookId={id} />)
    .with("location", () => <LocationPreviewContent locationId={id} />)
    .with("inventory", () => <InventoryPreviewContent inventoryId={id} />)
    .with("meal", () => <MealPreviewContent mealId={id} />)
    .with("project", () => <ProjectPreviewContent projectId={id} />)
    .with("task", () => <TaskPreviewContent taskId={id} />)
    .with("expense", () => <ExpensePreviewContent expenseId={id} />)
    .with("purchase", () => <PurchasePreviewContent purchaseId={id} />)
    .with("vendor", () => <VendorPreviewContent vendorId={id} />)
    .exhaustive();
}

// ── Recipe ──────────────────────────────────────────────────────────────────

export type RecipePreview = {
  id: string;
  name: string;
  yieldText?: string;
  cost?: number;
  calories?: number;
  /** Whole-recipe macros (nutrient-code map); paired with nutrientsLabel. */
  nutrients?: Record<string, number>;
  nutrientsLabel?: string;
  ingredientCount: number;
  /** Ingredients contributing to cost / nutrition — drives a "N/total" caption. */
  costCovered?: number;
  nutritionCovered?: number;
  stepCount: number;
  thumbUrl?: string;
};

/** "9/13" when partial, undefined when fully covered (or unknown). */
const coverageCaption = (
  covered: number | undefined,
  total: number,
): string | undefined => {
  const { complete, fraction } = coverageLabel(covered, total);
  return complete ? undefined : fraction;
};

export function toRecipeCard(vm: RecipePreview): ManifestCardProps {
  const stats: { label: string; value: ReactNode; caption?: string }[] = [];
  if (vm.cost != null)
    stats.push({
      label: "Cost",
      value: formatCurrency(vm.cost),
      caption: coverageCaption(vm.costCovered, vm.ingredientCount),
    });
  if (vm.calories != null)
    stats.push({
      label: "Calories",
      value: `${Math.round(vm.calories)} kcal`,
      caption: coverageCaption(vm.nutritionCovered, vm.ingredientCount),
    });
  stats.push({ label: "Ingredients", value: vm.ingredientCount });
  if (vm.stepCount > 0) stats.push({ label: "Steps", value: vm.stepCount });

  const body: BodyBlock[] = [];
  if (vm.thumbUrl) body.push({ kind: "thumb", url: vm.thumbUrl });
  if (vm.nutrients)
    body.push({
      kind: "nutrients",
      nutrients: vm.nutrients,
      label: vm.nutrientsLabel,
    });
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
        to: "/recipes/$shortcode",
        params: { shortcode: vm.id },
        search: { view: "prep" },
        icon: <ListChecks className="size-3" />,
        label: "Prep sheet",
      },
    ],
    body,
  };
}

export function RecipePreviewContent({ recipeId }: { recipeId: string }) {
  const trpc = useTRPC();
  const query = useQuery(trpc.recipe.getByID.queryOptions({ id: recipeId }));

  return (
    <PreviewQuery query={query} label="Recipe">
      {(data) => {
        // Whole-recipe macros from persisted totals. Older rows may not have
        // them yet, so buildNutrients drops missing values.
        const macros = buildNutrients(
          RECIPE_MACRO_KEYS.reduce<
            Partial<Record<NutrientKey, number | undefined>>
          >((acc, key) => {
            acc[key] = data.totals?.[`${key}Total`];
            return acc;
          }, {}),
        );
        return (
          <ManifestCard
            {...toRecipeCard({
              id: data.id,
              name: data.name,
              yieldText: data.yield?.value
                ? `makes ${formatYield(data.yield)}`
                : data.servings
                  ? `${data.servings} servings`
                  : undefined,
              cost: data.totals?.costTotal,
              calories: data.totals?.caloriesTotal,
              nutrients: Object.keys(macros).length > 0 ? macros : undefined,
              nutrientsLabel: "Per recipe",
              costCovered: data.totals?.costCovered,
              nutritionCovered: data.totals?.caloriesCovered,
              ingredientCount:
                data.totals?.ingredientCount ??
                sumBy(data.sections, (s) => s.ingredients.length),
              stepCount: sumBy(data.sections, (s) => s.instructions.length),
              thumbUrl: data.images.find(isDisplayableImageFile)?.url,
            })}
          />
        );
      }}
    </PreviewQuery>
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
  /** An ingredient has no images of its own — the first product's cover stands in. */
  thumbUrl?: string;
  products: {
    id: string;
    name: string;
    manufacturer: string;
  }[];
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
  if (vm.thumbUrl) body.push({ kind: "thumb", url: vm.thumbUrl });
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
      vm.usdaFdcId != null ? [usdaCrossLink(vm.usdaFdcId)] : undefined,
    body,
  };
}

export function IngredientPreviewContent({
  ingredientId,
}: {
  ingredientId: string;
}) {
  const trpc = useTRPC();
  const query = useQuery(
    trpc.ingredient.getByID.queryOptions({ id: ingredientId }),
  );

  return (
    <PreviewQuery query={query} label="Ingredient">
      {(data) => {
        const prices = data.product
          .map((prod) => prod.pricing.effectivePrice)
          .filter((value): value is number => value != null);
        return (
          <ManifestCard
            {...toIngredientCard({
              id: data.id,
              name: data.name,
              aliases: data.aliases ?? [],
              nutrients: data.product.find((prod) => prod.food?.nutritionInfo)
                ?.food?.nutritionInfo.nutrientsPer100,
              cheapestPrice:
                prices.length > 0 ? Math.min(...prices) : undefined,
              multiplePrices: prices.length > 1,
              recipeCount: data.appearsInRecipes.length,
              usdaFdcId: data.product.find((prod) => prod.food)?.food?.fdc_id,
              thumbUrl: data.product
                .flatMap((prod) => prod.images)
                .find(isDisplayableImageFile)?.url,
              products: data.product.map((prod) => ({
                id: prod.id,
                name: prod.name,
                manufacturer: prod.manufacturer,
              })),
            })}
          />
        );
      }}
    </PreviewQuery>
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
      vm.usdaFdcId != null ? [usdaCrossLink(vm.usdaFdcId)] : undefined,
    body,
  };
}

export function ProductPreviewContent({ productId }: { productId: string }) {
  const trpc = useTRPC();
  const query = useQuery(trpc.product.getByID.queryOptions({ id: productId }));

  return (
    <PreviewQuery query={query} label="Product">
      {(data) => {
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
              id: data.id,
              name: isMisc ? getMiscDisplayName(data.name) : data.name,
              identity:
                [isMisc ? "misc" : manufacturer, data.category]
                  .filter(Boolean)
                  .join(" · ") || undefined,
              nutrients: data.food?.nutritionInfo.nutrientsPer100,
              price: data.pricing.effectivePrice ?? undefined,
              upc: data.upc ?? undefined,
              thumbUrl: data.images.find(isDisplayableImageFile)?.url,
              usdaFdcId: data.food?.fdc_id ?? data.fdc_id ?? undefined,
            })}
          />
        );
      }}
    </PreviewQuery>
  );
}

// ── USDA food ───────────────────────────────────────────────────────────────

export type UsdaPreview = {
  fdcId: number;
  name: string;
  dataType?: DataType;
  brand?: string;
  nutrients: Record<string, number>;
  linkedProductShortcode?: string;
  linkedProductName?: string;
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
    crossLinks: vm.linkedProductShortcode
      ? [
          {
            to: "/products/$shortcode",
            params: { shortcode: vm.linkedProductShortcode },
            icon: <EntityIcon entity="product" size={12} colored />,
            label: vm.linkedProductName ?? "Product",
          },
        ]
      : undefined,
    body: [{ kind: "nutrients", nutrients: vm.nutrients }],
  };
}

export function UsdaFoodPreviewContent({ fdcId }: { fdcId: number }) {
  const trpc = useTRPC();
  const query = useQuery(trpc.usda.getByID.queryOptions({ id: fdcId }));

  return (
    <PreviewQuery query={query} label="Food">
      {(data) => (
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
            linkedProductShortcode: data.linkedProducts[0]?.id,
            linkedProductName: data.linkedProducts[0]?.name,
          })}
        />
      )}
    </PreviewQuery>
  );
}

// ── Location ────────────────────────────────────────────────────────────────

export type LocationPreview = {
  id: string;
  name: string;
  type: LocationType | null;
  /** The SKU this location IS — drives the glyph when `type` is null. */
  product: LocationIdentityProductOut | null;
  parent?: { id: string; name: string };
  itemCount?: number;
  subCount?: number;
  thumbUrl?: string;
};

export function toLocationCard(vm: LocationPreview): ManifestCardProps {
  const stats: { label: string; value: ReactNode }[] = [];
  if (vm.itemCount != null)
    stats.push({ label: "On hand", value: vm.itemCount });
  if (vm.subCount != null)
    stats.push({ label: "Sub-locations", value: vm.subCount });

  const body: BodyBlock[] = [];
  if (vm.thumbUrl) body.push({ kind: "thumb", url: vm.thumbUrl });
  if (stats.length > 0) body.push({ kind: "stats", stats });

  return {
    entity: "location",
    routeParam: vm.id,
    // `product` is load-bearing, not decoration: a location that IS a SKU has a
    // null `type`, and getLocationGlyph falls back to the product's category.
    icon: (
      <LocationIcon type={vm.type} product={vm.product} size={14} colored />
    ),
    name: vm.name,
    tag: "location",
    // Parent isn't repeated here — it lives in the cross-link below.
    // `type ?? product.name` is LocationTypeLabel's rule: a product-linked
    // location has no type, and this line read blank for every one of them.
    identity: vm.type ?? vm.product?.name,
    crossLinks: vm.parent
      ? [
          {
            to: "/locations/$shortcode",
            params: { shortcode: vm.parent.id },
            icon: <EntityIcon entity="location" size={12} colored />,
            label: vm.parent.name,
          },
        ]
      : undefined,
    body: body.length > 0 ? body : undefined,
  };
}

export function LocationPreviewContent({ locationId }: { locationId: string }) {
  const trpc = useTRPC();
  const query = useQuery(
    trpc.location.getByID.queryOptions({ id: locationId }),
  );

  return (
    <PreviewQuery query={query} label="Location">
      {(data) => (
        <ManifestCard
          {...toLocationCard({
            id: data.id,
            name: data.name,
            type: data.type,
            product: data.product,
            thumbUrl: locationCoverImage(data)?.url,
            parent: data.parent
              ? { id: data.parent.id, name: data.parent.name }
              : undefined,
            itemCount: data.totalItemCount ?? data.directItemCount ?? undefined,
            subCount: data.childCount ?? data.children?.length ?? undefined,
          })}
        />
      )}
    </PreviewQuery>
  );
}

// ── Inventory ───────────────────────────────────────────────────────────────

export type InventoryPreview = {
  id: string;
  /** An entry has no name of its own — the product it holds identifies it. */
  productName: string;
  productId: string;
  locationName: string;
  locationId: string;
  locationType: LocationType | null;
  amountText: string;
  valuation?: number | null;
  thumbUrl?: string;
};

export function toInventoryCard(vm: InventoryPreview): ManifestCardProps {
  const stats: { label: string; value: ReactNode }[] = [
    { label: "On hand", value: vm.amountText },
  ];
  // Plain currency, not PriceValue — valuation is amount × price, a total, so
  // PriceValue's "/ea" unit-price suffix would misread it.
  if (vm.valuation != null)
    stats.push({ label: "Value", value: formatCurrency(vm.valuation) });

  const body: BodyBlock[] = [];
  if (vm.thumbUrl) body.push({ kind: "thumb", url: vm.thumbUrl });
  body.push({ kind: "stats", stats });

  return {
    entity: "inventory",
    routeParam: vm.id,
    icon: <EntityIcon entity="inventory" size={14} colored />,
    name: vm.productName,
    tag: "inventory",
    identity: vm.locationName,
    crossLinks: [
      {
        to: "/products/$shortcode",
        params: { shortcode: vm.productId },
        icon: <EntityIcon entity="product" size={12} colored />,
        label: vm.productName,
      },
      {
        to: "/locations/$shortcode",
        params: { shortcode: vm.locationId },
        icon: (
          <LocationIcon
            type={vm.locationType}
            product={null}
            size={12}
            colored
          />
        ),
        label: vm.locationName,
      },
    ],
    body,
  };
}

export function InventoryPreviewContent({
  inventoryId,
}: {
  inventoryId: string;
}) {
  const trpc = useTRPC();
  const query = useQuery(
    trpc.inventory.getByID.queryOptions({ id: inventoryId }),
  );

  return (
    <PreviewQuery query={query} label="Inventory item">
      {(data) => (
        <ManifestCard
          {...toInventoryCard({
            id: data.id,
            productName: isMiscProduct(data.product.name)
              ? getMiscDisplayName(data.product.name)
              : data.product.name,
            productId: data.product.id,
            locationName: data.location.name,
            locationId: data.location.id,
            locationType: data.location.type,
            amountText: tryFormatAmount(data.amount),
            valuation: data.valuation,
            thumbUrl: data.product.images.find(isDisplayableImageFile)?.url,
          })}
        />
      )}
    </PreviewQuery>
  );
}

// ── Cookbook ────────────────────────────────────────────────────────────────

export type CookbookPreview = {
  id: string;
  name: string;
  authors: string[];
  subjects: string[];
  recipeCount: number;
  sourceRecipeCount: number;
  coverUrl?: string | null;
};

export function toCookbookCard(vm: CookbookPreview): ManifestCardProps {
  const body: BodyBlock[] = [];
  if (vm.coverUrl) body.push({ kind: "thumb", url: vm.coverUrl });
  body.push({
    kind: "stats",
    stats: [
      {
        label: "Recipes",
        value: vm.recipeCount,
        // How many of the book's extracted recipes are actually imported.
        caption:
          vm.sourceRecipeCount > vm.recipeCount
            ? `of ${vm.sourceRecipeCount}`
            : undefined,
      },
      {
        label: "Subjects",
        value:
          vm.subjects.length > 0 ? vm.subjects.slice(0, 2).join(", ") : "—",
      },
    ],
  });

  return {
    entity: "cookbook",
    routeParam: vm.id,
    icon: <EntityIcon entity="cookbook" size={14} colored />,
    name: vm.name,
    tag: "cookbook",
    identity: vm.authors.length > 0 ? vm.authors.join(", ") : undefined,
    body,
  };
}

export function CookbookPreviewContent({ cookbookId }: { cookbookId: string }) {
  const trpc = useTRPC();
  // Cookbooks have no getByID endpoint — the browse index carries every field
  // the card needs and is already cached by /cookbooks (same source the detail
  // page's hero reads).
  const query = useQuery(trpc.recipe.listCookbooks.queryOptions());
  const cookbook = query.data?.find((c) => c.id === cookbookId);

  return (
    <PreviewQuery
      query={{ data: cookbook, isLoading: query.isLoading }}
      label="Cookbook"
    >
      {(data) => (
        <ManifestCard
          {...toCookbookCard({
            id: data.id,
            name: data.book,
            authors: data.author,
            subjects: data.subjects,
            recipeCount: data.recipeCount,
            sourceRecipeCount: data.sourceRecipeCount,
            coverUrl: data.coverUrl,
          })}
        />
      )}
    </PreviewQuery>
  );
}

// ── Meal ────────────────────────────────────────────────────────────────────

export type MealPreview = {
  id: string;
  name: string | null;
  date: string;
  recipeNames: string[];
  cost: number;
  calories: number;
  /** At least one planned recipe has no computed totals yet. */
  pending: boolean;
};

export function toMealCard(vm: MealPreview): ManifestCardProps {
  return {
    entity: "meal",
    routeParam: vm.id,
    icon: <EntityIcon entity="meal" size={14} colored />,
    // An unnamed meal is identified by its date — the same fallback the
    // calendar uses.
    name: vm.name || formatDate(vm.date),
    tag: "meal",
    identity: vm.name ? formatDate(vm.date) : undefined,
    body: [
      {
        kind: "stats",
        stats: [
          {
            label: "Recipes",
            value: vm.recipeNames.length,
            caption:
              vm.recipeNames.length > 0
                ? vm.recipeNames.slice(0, 2).join(", ")
                : undefined,
          },
          {
            label: "Cost",
            value: formatCurrency(vm.cost),
            caption: vm.pending ? "partial" : undefined,
          },
          { label: "Calories", value: `${Math.round(vm.calories)} kcal` },
        ],
      },
    ],
  };
}

export function MealPreviewContent({ mealId }: { mealId: string }) {
  const trpc = useTRPC();
  const query = useQuery(trpc.meal.getByID.queryOptions({ id: mealId }));

  return (
    <PreviewQuery query={query} label="Meal">
      {(data) => (
        <ManifestCard
          {...toMealCard({
            id: data.id,
            name: data.name,
            date: data.date,
            recipeNames: data.recipes.map((r) => r.recipe.name),
            cost: data.totals.costTotal,
            calories: data.totals.caloriesTotal,
            pending: data.totals.pending,
          })}
        />
      )}
    </PreviewQuery>
  );
}

// ── Project ─────────────────────────────────────────────────────────────────

// Cross-link to a task/expense's parent project (built identically for both).
//
// `taskOut`/`expenseOut` carry `projectId` (the project's shortcode, per the
// project/task/expense shortcode cutover) alongside `projectName`, so the
// cross-link needs no lookup of its own.
const projectCrossLink = (shortcode: string, name: string): CrossLink => ({
  to: "/projects/$shortcode",
  params: { shortcode },
  icon: <ProjectMarkById projectId={shortcode} size={12} />,
  label: name,
});

export type ProjectPreview = {
  id: string;
  name: string;
  icon?: string | null;
  status: ProjectStatus;
  kind: ProjectKind | null;
  locations: string[];
  spent: number;
  costEstimate?: number | null;
  taskCount: number;
  doneTaskCount: number;
  expenseCount: number;
  // The EFFECTIVE window (derived rollup or manual override, whichever
  // wins) — see `projectDateWindow` in packages/schemas/src/project.ts.
  // Never the raw `startDate`/`endDate` override columns. Optional (like
  // `costEstimate` above) so existing static callers (design gallery
  // samples) aren't forced to supply it.
  effectiveStart?: string | null;
  effectiveEnd?: string | null;
  thumbUrl?: string;
};

export function toProjectCard(vm: ProjectPreview): ManifestCardProps {
  const identity = [
    PROJECT_STATUS_LABELS[vm.status],
    vm.kind ? capitalize(vm.kind) : null,
    vm.locations.length > 0 ? vm.locations.join(", ") : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return {
    entity: "project",
    routeParam: vm.id,
    icon: <ProjectMark icon={vm.icon} />,
    name: vm.name,
    tag: "project",
    identity,
    body: [
      ...(vm.thumbUrl ? [{ kind: "thumb" as const, url: vm.thumbUrl }] : []),
      {
        kind: "stats",
        stats: [
          {
            label: "Spent",
            value: formatCurrency(vm.spent),
            caption:
              vm.costEstimate != null
                ? `of ${formatCurrency(vm.costEstimate, 0)}`
                : undefined,
          },
          { label: "Tasks", value: `${vm.doneTaskCount}/${vm.taskCount}` },
          { label: "Expenses", value: vm.expenseCount },
          {
            label: "Dates",
            value: formatDateRange(
              vm.effectiveStart ?? null,
              vm.effectiveEnd ?? null,
            ),
          },
        ],
      },
    ],
  };
}

export function ProjectPreviewContent({ projectId }: { projectId: string }) {
  const trpc = useTRPC();
  const query = useQuery(trpc.project.getByID.queryOptions({ id: projectId }));
  // Projects deliberately carry no `images` on `getByID` — `projectOut` is also
  // `project.list`'s output, so widening it would buy a per-row image join on
  // every list page (see repo/image.ts's getImagesByProjectIds). This endpoint
  // is the established path, already displayable-filtered and cover-first, and
  // the projects dashboard usually leaves it warm in the cache. The card never
  // waits on it: the thumb just appears when it lands.
  const coverQuery = useQuery(
    trpc.image.imagesByProjectIds.queryOptions({ projectIds: [projectId] }),
  );

  return (
    <PreviewQuery query={query} label="Project">
      {(data) => (
        <ManifestCard
          {...toProjectCard({
            id: projectId,
            name: data.name,
            icon: data.icon,
            status: data.status,
            kind: data.kind,
            locations: data.locations,
            spent: data.rollup.spent,
            costEstimate: data.costEstimate,
            taskCount: data.rollup.taskCount,
            doneTaskCount: data.rollup.doneTaskCount,
            expenseCount: data.rollup.expenseCount,
            effectiveStart: data.dates.effectiveStart,
            effectiveEnd: data.dates.effectiveEnd,
            thumbUrl: coverQuery.data?.[projectId]?.[0]?.url,
          })}
        />
      )}
    </PreviewQuery>
  );
}

// ── Task ────────────────────────────────────────────────────────────────────

export type TaskPreview = {
  id: string;
  name: string;
  status: TaskStatus;
  trade: Trade | null;
  dueDate: string | null;
  dueEndDate: string | null;
  projectId?: string | null;
  projectName?: string | null;
};

export function toTaskCard(vm: TaskPreview): ManifestCardProps {
  const identity = [
    TASK_STATUS_LABELS[vm.status],
    vm.trade ? TRADE_LABELS[vm.trade] : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return {
    entity: "task",
    routeParam: vm.id,
    icon: <EntityIcon entity="task" size={14} colored />,
    name: vm.name,
    tag: "task",
    identity,
    crossLinks:
      vm.projectId && vm.projectName
        ? [projectCrossLink(vm.projectId, vm.projectName)]
        : undefined,
    body: [
      {
        kind: "stats",
        stats: [
          { label: "Status", value: TASK_STATUS_LABELS[vm.status] },
          {
            label: "Due",
            value: formatDateRange(vm.dueDate, vm.dueEndDate),
          },
        ],
      },
    ],
  };
}

export function TaskPreviewContent({ taskId }: { taskId: string }) {
  const trpc = useTRPC();
  const query = useQuery(trpc.task.getByID.queryOptions({ id: taskId }));

  return (
    <PreviewQuery query={query} label="Task">
      {(data) => (
        <ManifestCard
          {...toTaskCard({
            id: taskId,
            name: data.name,
            status: data.status,
            trade: data.trade,
            dueDate: data.dueDate,
            dueEndDate: data.dueEndDate,
            projectId: data.projectId,
            projectName: data.projectName,
          })}
        />
      )}
    </PreviewQuery>
  );
}

// ── Expense ────────────────────────────────────────────────────────────────

export type ExpensePreview = {
  id: string;
  name: string;
  cost: number | null;
  date: string | null;
  costType: CostType | null;
  trade: Trade | null;
  future: boolean;
  vendor?: string | null;
  orderId?: string | null;
  orderUrl?: string | null;
  projectId?: string | null;
  projectName?: string | null;
};

export function toExpenseCard(vm: ExpensePreview): ManifestCardProps {
  const identity =
    [
      vm.costType ? costTypeLabels[vm.costType] : null,
      vm.trade ? TRADE_LABELS[vm.trade] : null,
    ]
      .filter(Boolean)
      .join(" · ") + (vm.future ? " · planned" : "");

  const stats: { label: string; value: ReactNode }[] = [
    { label: "Cost", value: vm.cost != null ? formatCurrency(vm.cost) : "—" },
    { label: "Date", value: vm.date ? formatDate(vm.date) : "—" },
  ];
  if (vm.vendor) stats.push({ label: "Vendor", value: vm.vendor });
  if (vm.orderId)
    stats.push({
      label: "Order #",
      value: (
        <Row align="center" gap="xs">
          <span className="font-mono text-xs">{vm.orderId}</span>
          <OrderIdLink
            orderUrl={vm.orderUrl}
            orderId={vm.orderId}
            vendorName={vm.vendor}
          />
        </Row>
      ),
    });

  return {
    entity: "expense",
    routeParam: vm.id,
    icon: <EntityIcon entity="expense" size={14} colored />,
    name: vm.name,
    tag: "expense",
    identity: identity || undefined,
    crossLinks:
      vm.projectId && vm.projectName
        ? [projectCrossLink(vm.projectId, vm.projectName)]
        : undefined,
    body: [{ kind: "stats", stats }],
  };
}

export function ExpensePreviewContent({ expenseId }: { expenseId: string }) {
  const trpc = useTRPC();
  const query = useQuery(trpc.expense.getByID.queryOptions({ id: expenseId }));

  return (
    <PreviewQuery query={query} label="Expense">
      {(data) => (
        <ManifestCard
          {...toExpenseCard({
            id: expenseId,
            name: data.name,
            cost: data.cost,
            date: data.date,
            costType: data.costType,
            trade: data.trade,
            future: data.future,
            vendor: data.vendor,
            orderId: data.orderId,
            orderUrl: data.orderUrl,
            projectId: data.projectId,
            projectName: data.projectName,
          })}
        />
      )}
    </PreviewQuery>
  );
}

// ── Purchase ────────────────────────────────────────────────────────────────

/**
 * Cross-link to the vendor that issued a purchase — the purchase's primary
 * context. `purchaseOut.vendorId` is the vendor's shortcode (per the
 * vendor/purchase shortcode cutover), denormalized alongside `vendorName` by
 * the purchase query, so the cross-link needs no lookup of its own.
 */
const vendorCrossLink = (shortcode: string, name: string): CrossLink => ({
  to: "/vendors/$shortcode",
  params: { shortcode },
  icon: <EntityIcon entity="vendor" size={12} colored />,
  label: name,
});

export type PurchasePreview = {
  id: string;
  orderId: string | null;
  displayLabel?: string | null;
  date: string | null;
  statedTotal: number | null;
  expenseCount: number;
  expenseTotal: number;
  vendorId?: string | null;
  vendorName?: string | null;
  orderUrl?: string | null;
};

export function toPurchaseCard(vm: PurchasePreview): ManifestCardProps {
  return {
    entity: "purchase",
    routeParam: vm.id,
    icon: <EntityIcon entity="purchase" size={14} colored />,
    // No `name` column on a purchase — the shared label ladder owns this so the
    // hovercard and every inline link read the same purchase the same way.
    name: purchaseLabel(vm),
    tag: "purchase",
    identity: vm.date ? formatDate(vm.date) : undefined,
    crossLinks:
      vm.vendorId && vm.vendorName
        ? [vendorCrossLink(vm.vendorId, vm.vendorName)]
        : undefined,
    body: [
      {
        kind: "stats",
        stats: [
          {
            // The purchase's real spend. `statedTotal` rides along as a caption
            // rather than a peer stat — it is what the paperwork claimed, never
            // money (see purchase.ts), and the two legitimately disagree.
            label: "Expense total",
            value: formatCurrency(vm.expenseTotal),
            caption:
              vm.statedTotal != null
                ? `of ${formatCurrency(vm.statedTotal, 0)} stated`
                : undefined,
          },
          { label: "Expenses", value: vm.expenseCount },
          {
            label: "Order #",
            value: vm.orderId ? (
              <Row align="center" gap="xs">
                <span className="font-mono text-xs">{vm.orderId}</span>
                <OrderIdLink
                  orderUrl={vm.orderUrl}
                  orderId={vm.orderId}
                  vendorName={vm.vendorName}
                />
              </Row>
            ) : (
              "—"
            ),
          },
          { label: "Date", value: vm.date ? formatDate(vm.date) : "—" },
        ],
      },
    ],
  };
}

export function PurchasePreviewContent({ purchaseId }: { purchaseId: string }) {
  const trpc = useTRPC();
  const query = useQuery(
    trpc.purchase.getByID.queryOptions({ id: purchaseId }),
  );

  return (
    <PreviewQuery query={query} label="Purchase">
      {(data) => (
        <ManifestCard
          {...toPurchaseCard({
            id: purchaseId,
            orderId: data.orderId,
            displayLabel: data.displayLabel,
            date: data.date,
            statedTotal: data.statedTotal,
            expenseCount: data.expenseCount,
            expenseTotal: data.expenseTotal,
            vendorId: data.vendorId,
            vendorName: data.vendorName,
            orderUrl: data.orderUrl,
          })}
        />
      )}
    </PreviewQuery>
  );
}

// ── Vendor ──────────────────────────────────────────────────────────────────

export type VendorPreview = {
  id: string;
  name: string;
  purchaseCount: number;
  spend: number;
};

export function toVendorCard(vm: VendorPreview): ManifestCardProps {
  return {
    entity: "vendor",
    routeParam: vm.id,
    icon: <EntityIcon entity="vendor" size={14} colored />,
    name: vm.name,
    tag: "vendor",
    body: [
      {
        kind: "stats",
        stats: [
          // `spend` is SUM(expense.cost) over this vendor's purchases' lines — a
          // rollup, never a column on the vendor row.
          { label: "Spend", value: formatCurrency(vm.spend, 0) },
          { label: "Purchases", value: vm.purchaseCount },
        ],
      },
    ],
  };
}

export function VendorPreviewContent({ vendorId }: { vendorId: string }) {
  const trpc = useTRPC();
  const query = useQuery(trpc.vendor.getByID.queryOptions({ id: vendorId }));

  return (
    <PreviewQuery query={query} label="Vendor">
      {(data) => (
        <ManifestCard
          {...toVendorCard({
            id: vendorId,
            name: data.name,
            purchaseCount: data.purchaseCount,
            spend: data.spend,
          })}
        />
      )}
    </PreviewQuery>
  );
}
