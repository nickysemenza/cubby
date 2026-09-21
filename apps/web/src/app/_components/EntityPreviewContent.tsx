import { displayGtin } from "@cubby/schemas/external-id";
import {
  currentLast4,
  type FinancialAccountOut,
} from "@cubby/schemas/financial-account";
import type { GardenEntryKind } from "@cubby/schemas/garden-fields";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { ImageAssociation, ImageWithEntity } from "@cubby/schemas/image";
import { hasKnownEstimate } from "@cubby/schemas/nutrition";
import type { CookbookSummary } from "@cubby/schemas/recipe";
import type { FoodSummaryWithLinkedProducts } from "@cubby/schemas/usda";
import { getMiscDisplayName, isMiscProduct } from "@cubby/shared";
import {
  KEY_NUTRIENT_KEYS,
  TIER1_NUTRIENTS,
  dataTypeLabel,
} from "@cubby/usda-schemas";
import { useQuery } from "@tanstack/react-query";
import { sumBy } from "es-toolkit";
import { ListChecks } from "lucide-react";
import { type ComponentType, type ReactNode, useEffect } from "react";

import type { EntityActionRow } from "~/app/_components/actions/entity-actions";
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
import { wishPriceRange } from "~/app/wishes/wish-price-range";
import { Row } from "~/components/layout";
import { cookbook } from "~/entities/cookbook.functions";
import { EntityIcon, entities, entityDetailParams } from "~/entities/entities";
import { entityDetailFor } from "~/entities/entity-detail.functions";
import { fdcIdFromParam } from "~/entities/entity-query";
import type { EntityDetailByEntity } from "~/entities/generated/entity-details.gen";
import { image } from "~/entities/image.functions";
import { usdaFood } from "~/entities/usda.functions";
import { formatCurrencyRange } from "~/lib/format-range";
import { isUnspecifiedManufacturer } from "~/lib/manufacturer-utils";
import { formatEstimate } from "~/lib/nutrition-format";
import { countLabel } from "~/lib/pluralize";
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
import { formatYield } from "./recipe/recipe-utils";

type CompactPreviewPresentation = {
  showOpenAction?: boolean;
  showIdentityHeader?: boolean;
  onNameResolved?: (name: string) => void;
  /** The inspector reuses this successful detail payload for its actions. */
  onRecordResolved?: (record: EntityActionRow | undefined) => void;
};

type StandardPreviewPresentation = Required<
  Pick<CompactPreviewPresentation, "showOpenAction" | "showIdentityHeader">
> &
  Pick<CompactPreviewPresentation, "onNameResolved" | "onRecordResolved">;

function ResolvedManifestCard({
  card,
  record,
  showOpenAction,
  showIdentityHeader,
  onNameResolved,
  onRecordResolved,
}: CompactPreviewPresentation & {
  card: ManifestCardProps;
  record: EntityActionRow;
}) {
  useEffect(() => {
    onNameResolved?.(card.name);
  }, [card.name, onNameResolved]);
  useEffect(() => {
    onRecordResolved?.(record);
  }, [onRecordResolved, record]);

  return (
    <ManifestCard
      {...card}
      showOpenAction={showOpenAction}
      showIdentityHeader={showIdentityHeader}
    />
  );
}

// Cross-link to the USDA food behind an ingredient/product (built identically
// for both). The food description is too long to use as the label, so the
// apple icon + type label carry it.
const usdaCrossLink = (fdcId: number): CrossLink => ({
  to: "/usda/$id",
  params: { id: String(fdcId) },
  icon: <EntityIcon entity="usda-food" size={12} colored />,
  label: "USDA food",
});

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

/** "9/13" when partial, undefined when fully covered (or unknown). */
// Each toXCard maps an entity-detail payload straight into the declarative
// ManifestCardProps the shared <ManifestCard> renders — no intermediate
// view-model. <GenericPreviewContent> below pairs each one with its query in
// PREVIEW_TABLE; usda-food and cookbook stay their own tiny components
// because their fetch shape genuinely diverges (fdc_id coercion, list-backed
// detail without a dedicated endpoint).

// ── Recipe ──────────────────────────────────────────────────────────────────

export function toRecipeCard(
  data: EntityDetailByEntity["recipe"],
): ManifestCardProps {
  const ingredientCount = sumBy(
    data.sections,
    (section) => section.ingredients.length,
  );
  const stepCount = sumBy(data.sections, (s) => s.instructions.length);
  const yieldText = data.yield?.value
    ? `makes ${formatYield(data.yield)}`
    : data.servings
      ? countLabel(data.servings, "serving")
      : undefined;
  const thumbUrl = data.displayImages[0]?.url;

  const stats: { label: string; value: ReactNode; caption?: string }[] = [];
  if (data.totals) {
    stats.push({
      label: "Cost",
      value: formatEstimate(data.totals.cost, formatCurrency),
    });
    for (const key of KEY_NUTRIENT_KEYS) {
      const estimate = data.totals.nutrition[key];
      const info = TIER1_NUTRIENTS[key];
      stats.push({
        label: info.displayName,
        value: formatEstimate(
          estimate,
          (value) =>
            `${info.unit === "G" ? value.toFixed(1) : Math.round(value)} ${info.unit.toLowerCase()}`,
        ),
        caption:
          hasKnownEstimate(estimate) && estimate.status === "partial"
            ? `${estimate.coverage.covered}/${estimate.coverage.total} ingredient rows`
            : undefined,
      });
    }
  } else stats.push({ label: "Nutrition", value: "Pending" });
  stats.push({ label: "Ingredients", value: ingredientCount });
  if (stepCount > 0) stats.push({ label: "Steps", value: stepCount });

  const body: BodyBlock[] = [];
  if (thumbUrl) body.push({ kind: "thumb", url: thumbUrl });
  body.push({ kind: "stats", stats });

  return {
    entity: "recipe",
    routeParam: data.id,
    icon: <EntityIcon entity="recipe" size={14} colored />,
    name: data.name,
    tag: "recipe",
    identity: yieldText,
    crossLinks: [
      {
        to: "/recipes/$shortcode",
        params: { shortcode: data.id },
        search: { view: "prep" },
        icon: <ListChecks className="size-3" />,
        label: "Prep sheet",
      },
    ],
    body,
  };
}

// ── Ingredient ──────────────────────────────────────────────────────────────

export function toIngredientCard(
  data: EntityDetailByEntity["ingredient"],
): ManifestCardProps {
  const prices = data.product
    .map((prod) => prod.pricing.effectivePrice)
    .filter((value): value is number => value != null);
  const cheapestPrice = prices.length > 0 ? Math.min(...prices) : undefined;
  const multiplePrices = prices.length > 1;
  const thumbUrl = data.displayImages[0]?.url;
  const nutrients = data.product.find((prod) => prod.food?.nutritionInfo)?.food
    ?.nutritionInfo.nutrientsPer100;
  const usdaFdcId = data.product.find((prod) => prod.food)?.food?.fdc_id;
  const aliases = data.aliases ?? [];

  const stats: { label: string; value: ReactNode }[] = [];
  if (cheapestPrice != null)
    stats.push({
      label: "Price",
      value: <PriceValue amount={cheapestPrice} from={multiplePrices} />,
    });
  stats.push({ label: "Recipes", value: data.appearsInRecipes.length });

  const body: BodyBlock[] = [];
  if (thumbUrl) body.push({ kind: "thumb", url: thumbUrl });
  if (nutrients) body.push({ kind: "nutrients", nutrients });
  body.push({ kind: "stats", stats });
  if (data.product.length > 0)
    body.push({
      kind: "products",
      products: data.product.map((prod) => ({
        id: prod.id,
        name: prod.name,
        manufacturer: prod.manufacturer,
      })),
    });

  return {
    entity: "ingredient",
    routeParam: data.id,
    icon: <EntityIcon entity="ingredient" size={14} colored />,
    name: data.name,
    tag: "ingredient",
    identity: aliases.length > 0 ? `aka ${aliases.join(", ")}` : undefined,
    crossLinks: usdaFdcId != null ? [usdaCrossLink(usdaFdcId)] : undefined,
    body,
  };
}

// ── Product ─────────────────────────────────────────────────────────────────

function productCardBody(data: EntityDetailByEntity["product"]): BodyBlock[] {
  const body: BodyBlock[] = [];
  const thumbUrl = data.displayImages[0]?.url;
  if (thumbUrl) body.push({ kind: "thumb", url: thumbUrl });
  if (data.food?.nutritionInfo.nutrientsPer100)
    body.push({
      kind: "nutrients",
      nutrients: data.food.nutritionInfo.nutrientsPer100,
    });
  const stats: { label: string; value: ReactNode }[] = [];
  if (data.pricing.effectivePrice != null)
    stats.push({
      label: "Price",
      value: <PriceValue amount={data.pricing.effectivePrice} />,
    });
  if (data.primaryGtin !== null)
    stats.push({
      label: "UPC",
      value: (
        <span className="font-mono text-xs">
          {displayGtin(data.primaryGtin)}
        </span>
      ),
    });
  if (data.onHandUnits != null)
    stats.push({ label: "On hand", value: data.onHandUnits });
  const locationNames = [
    ...data.inventoryEntry.map((entry) => entry.location.name),
    ...data.servingAsLocations.map((location) => location.name),
  ];
  if (locationNames.length > 0)
    stats.push({
      label: locationNames.length === 1 ? "Location" : "Locations",
      value:
        locationNames.length > 2
          ? countLabel(locationNames.length, "location")
          : locationNames.join(", "),
    });
  if (stats.length > 0) body.push({ kind: "stats", stats });
  return body;
}

export function toProductCard(
  data: EntityDetailByEntity["product"],
): ManifestCardProps {
  const isMisc = isMiscProduct(data.name);
  const manufacturer =
    !isMisc &&
    data.manufacturer &&
    !isUnspecifiedManufacturer(data.manufacturer)
      ? data.manufacturer
      : null;
  const identity =
    [isMisc ? "misc" : manufacturer, data.category]
      .filter(Boolean)
      .join(" · ") || undefined;
  const usdaFdcId = data.food?.fdc_id ?? data.fdc_id ?? undefined;
  // "How many, and where" is the question a product hover is usually asking —
  // and the detail read behind this card already carries both, so showing them
  // costs nothing. Omitted entirely for a product that isn't stocked, rather
  // than shown as a zero it never counted.
  // Stock entries plus the bins that ARE this product — a tote in service is
  // just as much an answer to "where is it".

  return {
    entity: "product",
    routeParam: data.id,
    icon: <EntityIcon entity="product" size={14} colored />,
    name: isMisc ? getMiscDisplayName(data.name) : data.name,
    tag: "product",
    identity,
    crossLinks: usdaFdcId != null ? [usdaCrossLink(usdaFdcId)] : undefined,
    body: productCardBody(data),
  };
}

// ── USDA food ───────────────────────────────────────────────────────────────

export function toUsdaCard(
  fdcId: number,
  data: FoodSummaryWithLinkedProducts,
): ManifestCardProps {
  const dataType = data.foodInfo.data_type;
  const brand =
    data.brandedFoodInfo?.brand_name ??
    data.brandedFoodInfo?.brand_owner ??
    undefined;
  const linkedProduct = data.linkedProducts[0];

  return {
    entity: "usda-food",
    routeParam: String(fdcId),
    icon: dataType ? (
      <EntityIcon
        entity="usda-food"
        size={14}
        style={{ color: dataTypeColor(dataType) }}
      />
    ) : (
      <EntityIcon entity="usda-food" size={14} colored />
    ),
    name: data.foodInfo.description || "Unnamed Food",
    tag: "usda",
    identity: dataType ? (
      <>
        <UsdaDataTypeDot dataType={dataType} />
        {dataTypeLabel(dataType)}
        {brand && <span>· {brand}</span>}
      </>
    ) : undefined,
    crossLinks: linkedProduct
      ? [
          {
            to: "/products/$shortcode",
            params: { shortcode: linkedProduct.id },
            icon: <EntityIcon entity="product" size={12} colored />,
            label: linkedProduct.name ?? "Product",
          },
        ]
      : undefined,
    body: [
      { kind: "nutrients", nutrients: data.nutritionInfo.nutrientsPer100 },
    ],
  };
}

export function UsdaFoodPreviewContent({
  fdcId,
  showOpenAction = true,
  showIdentityHeader = true,
  onNameResolved,
  onRecordResolved,
}: { fdcId: number } & CompactPreviewPresentation) {
  const query = useQuery(usdaFood.detail.queryOptions({ id: fdcId }));

  return (
    <PreviewQuery query={query} label="Food" onUnavailable={onRecordResolved}>
      {(data) => (
        <ResolvedManifestCard
          card={toUsdaCard(fdcId, data)}
          record={{ ...data, id: String(fdcId) }}
          showOpenAction={showOpenAction}
          showIdentityHeader={showIdentityHeader}
          onNameResolved={onNameResolved}
          onRecordResolved={onRecordResolved}
        />
      )}
    </PreviewQuery>
  );
}

// ── Location ────────────────────────────────────────────────────────────────

export function toLocationCard(
  data: EntityDetailByEntity["location"],
): ManifestCardProps {
  const itemCount = data.totalItemCount ?? data.directItemCount ?? undefined;
  const subCount = data.childCount ?? data.children?.length ?? undefined;
  const thumbUrl = data.displayImages[0]?.url;

  const stats: { label: string; value: ReactNode }[] = [];
  if (itemCount != null) stats.push({ label: "On hand", value: itemCount });
  if (subCount != null) stats.push({ label: "Sub-locations", value: subCount });

  const body: BodyBlock[] = [];
  if (thumbUrl) body.push({ kind: "thumb", url: thumbUrl });
  if (stats.length > 0) body.push({ kind: "stats", stats });

  return {
    entity: "location",
    routeParam: data.id,
    // `product` is load-bearing, not decoration: a location that IS a SKU has a
    // null `type`, and getLocationGlyph falls back to the product's category.
    icon: (
      <LocationIcon type={data.type} product={data.product} size={14} colored />
    ),
    name: data.name,
    tag: "location",
    // Parent isn't repeated here — it lives in the cross-link below.
    // `type ?? product.name` is LocationTypeLabel's rule: a product-linked
    // location has no type, and this line read blank for every one of them.
    identity: data.type ?? data.product?.name,
    crossLinks: data.parent
      ? [
          {
            to: "/locations/$shortcode",
            params: { shortcode: data.parent.id },
            icon: <EntityIcon entity="location" size={12} colored />,
            label: data.parent.name,
          },
        ]
      : undefined,
    body: body.length > 0 ? body : undefined,
  };
}

// ── Inventory ───────────────────────────────────────────────────────────────

export function toInventoryCard(
  data: EntityDetailByEntity["inventory"],
): ManifestCardProps {
  const productName = isMiscProduct(data.product.name)
    ? getMiscDisplayName(data.product.name)
    : data.product.name;
  const thumbUrl = data.displayImages[0]?.url;

  const stats: { label: string; value: ReactNode }[] = [
    { label: "On hand", value: tryFormatAmount(data.amount) },
  ];
  // Plain currency, not PriceValue — valuation is amount × price, a total, so
  // PriceValue's "/ea" unit-price suffix would misread it.
  if (data.valuation != null)
    stats.push({ label: "Value", value: formatCurrency(data.valuation) });

  const body: BodyBlock[] = [];
  if (thumbUrl) body.push({ kind: "thumb", url: thumbUrl });
  body.push({ kind: "stats", stats });

  return {
    entity: "inventory",
    routeParam: data.id,
    icon: <EntityIcon entity="inventory" size={14} colored />,
    name: productName,
    tag: "inventory",
    identity: data.location.name,
    crossLinks: [
      {
        to: "/products/$shortcode",
        params: { shortcode: data.product.id },
        icon: <EntityIcon entity="product" size={12} colored />,
        label: productName,
      },
      {
        to: "/locations/$shortcode",
        params: { shortcode: data.location.id },
        icon: (
          <LocationIcon
            type={data.location.type}
            product={null}
            size={12}
            colored
          />
        ),
        label: data.location.name,
      },
    ],
    body,
  };
}

// ── Cookbook ────────────────────────────────────────────────────────────────

export function toCookbookCard(data: CookbookSummary): ManifestCardProps {
  const body: BodyBlock[] = [];
  if (data.coverUrl) body.push({ kind: "thumb", url: data.coverUrl });
  body.push({
    kind: "stats",
    stats: [
      {
        label: "Recipes",
        value: data.recipeCount,
        // How many of the book's extracted recipes are actually imported.
        caption:
          data.sourceRecipeCount > data.recipeCount
            ? `of ${data.sourceRecipeCount}`
            : undefined,
      },
      {
        label: "Subjects",
        value:
          data.subjects.length > 0 ? data.subjects.slice(0, 2).join(", ") : "—",
      },
    ],
  });

  return {
    entity: "cookbook",
    routeParam: data.id,
    icon: <EntityIcon entity="cookbook" size={14} colored />,
    name: data.book,
    tag: "cookbook",
    identity: data.author.length > 0 ? data.author.join(", ") : undefined,
    body,
  };
}

export function CookbookPreviewContent({
  cookbookId,
  showOpenAction = true,
  showIdentityHeader = true,
  onNameResolved,
  onRecordResolved,
}: { cookbookId: string } & CompactPreviewPresentation) {
  const query = useQuery(
    cookbook.detail.queryOptions({ shortcode: cookbookId }),
  );

  return (
    <PreviewQuery
      query={query}
      label="Cookbook"
      onUnavailable={onRecordResolved}
    >
      {(data) => (
        <ResolvedManifestCard
          card={toCookbookCard(data)}
          record={data}
          showOpenAction={showOpenAction}
          showIdentityHeader={showIdentityHeader}
          onNameResolved={onNameResolved}
          onRecordResolved={onRecordResolved}
        />
      )}
    </PreviewQuery>
  );
}

// ── Meal ────────────────────────────────────────────────────────────────────

export function toMealCard(
  data: EntityDetailByEntity["meal"],
): ManifestCardProps {
  return {
    entity: "meal",
    routeParam: data.id,
    icon: <EntityIcon entity="meal" size={14} colored />,
    name: data.displayName,
    tag: "meal",
    identity: data.name ? formatDate(data.date) : undefined,
    body: [
      {
        kind: "stats",
        stats: [
          {
            label: "Recipes",
            value: data.recipes.length,
            caption:
              data.recipes.length > 0
                ? data.recipes
                    .slice(0, 2)
                    .map((r) => r.recipe.name)
                    .join(", ")
                : undefined,
          },
          {
            label: "Cost",
            value: formatEstimate(data.totals.cost, formatCurrency),
          },
          {
            label: "Calories",
            value: formatEstimate(
              data.totals.nutrition.kcal,
              (value) => `${Math.round(value)} kcal`,
            ),
          },
        ],
      },
    ],
  };
}

// ── Project ─────────────────────────────────────────────────────────────────

export function toProjectCard(
  data: EntityDetailByEntity["project"] & { thumbUrl?: string },
): ManifestCardProps {
  const identity = [
    PROJECT_STATUS_LABELS[data.status],
    data.kind ? capitalize(data.kind) : null,
    data.locations.length > 0 ? data.locations.join(", ") : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return {
    entity: "project",
    routeParam: data.id,
    icon: <ProjectMark icon={data.icon} />,
    name: data.name,
    tag: "project",
    identity,
    body: [
      ...(data.thumbUrl
        ? [{ kind: "thumb" as const, url: data.thumbUrl }]
        : []),
      {
        kind: "stats",
        stats: [
          {
            label: "Spent",
            value: formatCurrency(data.rollup.spent),
            caption:
              data.costEstimate != null
                ? `of ${formatCurrency(data.costEstimate, 0)}`
                : undefined,
          },
          {
            label: "Tasks",
            value: `${data.rollup.doneTaskCount}/${data.rollup.taskCount}`,
          },
          { label: "Expenses", value: data.rollup.expenseCount },
          {
            label: "Dates",
            // The EFFECTIVE window (derived rollup or manual override,
            // whichever wins) — see `projectDateWindow` in
            // packages/schemas/src/project.ts. Never the raw
            // `startDate`/`endDate` override columns.
            value: formatDateRange(
              data.dates.effectiveStart ?? null,
              data.dates.effectiveEnd ?? null,
            ),
          },
        ],
      },
    ],
  };
}

// ── Task ────────────────────────────────────────────────────────────────────

export function toTaskCard(
  data: EntityDetailByEntity["task"],
): ManifestCardProps {
  const identity = [
    TASK_STATUS_LABELS[data.status],
    data.trade ? TRADE_LABELS[data.trade] : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return {
    entity: "task",
    routeParam: data.id,
    icon: <EntityIcon entity="task" size={14} colored />,
    name: data.name,
    tag: "task",
    identity,
    crossLinks:
      data.projectId && data.projectName
        ? [projectCrossLink(data.projectId, data.projectName)]
        : undefined,
    body: [
      {
        kind: "stats",
        stats: [
          { label: "Status", value: TASK_STATUS_LABELS[data.status] },
          {
            label: "Due",
            value: formatDateRange(data.dueDate, data.dueEndDate),
          },
        ],
      },
    ],
  };
}

// ── Expense ────────────────────────────────────────────────────────────────

export function toExpenseCard(
  data: EntityDetailByEntity["expense"],
): ManifestCardProps {
  const identity =
    [
      data.costType ? costTypeLabels[data.costType] : null,
      data.trade ? TRADE_LABELS[data.trade] : null,
    ]
      .filter(Boolean)
      .join(" · ") + (data.future ? " · planned" : "");

  const stats: { label: string; value: ReactNode }[] = [
    {
      label: "Cost",
      value: data.cost != null ? formatCurrency(data.cost) : "—",
    },
    { label: "Date", value: data.date ? formatDate(data.date) : "—" },
  ];
  if (data.vendor) stats.push({ label: "Vendor", value: data.vendor });
  if (data.orderId)
    stats.push({
      label: "Order #",
      value: (
        <Row align="center" gap="xs">
          <span className="font-mono text-xs">{data.orderId}</span>
          <OrderIdLink
            orderUrl={data.orderUrl}
            orderId={data.orderId}
            vendorName={data.vendor}
          />
        </Row>
      ),
    });

  return {
    entity: "expense",
    routeParam: data.id,
    icon: <EntityIcon entity="expense" size={14} colored />,
    name: data.name,
    tag: "expense",
    identity: identity || undefined,
    crossLinks:
      data.projectId && data.projectName
        ? [projectCrossLink(data.projectId, data.projectName)]
        : undefined,
    body: [{ kind: "stats", stats }],
  };
}

// ── Purchase ────────────────────────────────────────────────────────────────

export function toPurchaseCard(
  data: EntityDetailByEntity["purchase"],
): ManifestCardProps {
  return {
    entity: "purchase",
    routeParam: data.id,
    icon: <EntityIcon entity="purchase" size={14} colored />,
    // No `name` column on a purchase — the shared label ladder owns this so the
    // hovercard and every inline link read the same purchase the same way.
    name: purchaseLabel(data),
    tag: "purchase",
    identity: data.date ? formatDate(data.date) : undefined,
    crossLinks:
      data.vendorId && data.vendorName
        ? [vendorCrossLink(data.vendorId, data.vendorName)]
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
            value: formatCurrency(data.expenseTotal),
            caption:
              data.statedTotal != null
                ? `of ${formatCurrency(data.statedTotal, 0)} stated`
                : undefined,
          },
          { label: "Expenses", value: data.expenseCount },
          {
            label: "Order #",
            value: data.orderId ? (
              <Row align="center" gap="xs">
                <span className="font-mono text-xs">{data.orderId}</span>
                <OrderIdLink
                  orderUrl={data.orderUrl}
                  orderId={data.orderId}
                  vendorName={data.vendorName}
                />
              </Row>
            ) : (
              "—"
            ),
          },
          { label: "Date", value: data.date ? formatDate(data.date) : "—" },
        ],
      },
    ],
  };
}

// ── Vendor ──────────────────────────────────────────────────────────────────

export function toVendorCard(
  data: EntityDetailByEntity["vendor"],
): ManifestCardProps {
  return {
    entity: "vendor",
    routeParam: data.id,
    icon: <EntityIcon entity="vendor" size={14} colored />,
    name: data.name,
    tag: "vendor",
    body: [
      {
        kind: "stats",
        stats: [
          // `spend` is SUM(expense.cost) over this vendor's purchases' lines — a
          // rollup, never a column on the vendor row.
          { label: "Spend", value: formatCurrency(data.spend, 0) },
          { label: "Purchases", value: data.purchaseCount },
        ],
      },
    ],
  };
}

// ── Financial accounts ─────────────────────────────────────────────────────

function financialAccountIdentitySummary(
  identity: FinancialAccountOut["identity"],
  cardNumbers: FinancialAccountOut["cardNumbers"],
) {
  const provider =
    identity.kind === "credit_card"
      ? identity.issuer
      : identity.kind === "bank_account" || identity.kind === "other"
        ? identity.institution
        : identity.kind === "stored_value"
          ? identity.provider
          : null;
  const last4 = currentLast4(cardNumbers);

  return [
    capitalize(identity.kind.replaceAll("_", " ")),
    provider,
    last4 ? `•••• ${last4}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function toFinancialAccountCard(
  data: EntityDetailByEntity["financialAccount"],
): ManifestCardProps {
  return {
    entity: "financialAccount",
    routeParam: data.id,
    icon: <EntityIcon entity="financialAccount" size={14} colored />,
    name: data.name,
    tag: "account",
    identity: financialAccountIdentitySummary(data.identity, data.cardNumbers),
    body: [
      {
        kind: "stats",
        stats: [
          { label: "Transactions", value: data.transactionCount },
          {
            label: "Status",
            value: data.provisional ? "Provisional" : "Known",
          },
        ],
      },
    ],
  };
}

// ── Financial transactions ─────────────────────────────────────────────────

const financialAccountCrossLink = (
  shortcode: string,
  name: string,
): CrossLink => ({
  to: "/financial-accounts/$shortcode",
  params: { shortcode },
  icon: <EntityIcon entity="financialAccount" size={12} colored />,
  label: name,
});

export function toFinancialTransactionCard(
  data: EntityDetailByEntity["financialTransaction"],
): ManifestCardProps {
  return {
    entity: "financialTransaction",
    routeParam: data.id,
    icon: <EntityIcon entity="financialTransaction" size={14} colored />,
    name: data.displayName,
    tag: "transaction",
    identity: [
      capitalize(data.kind.replaceAll("_", " ")),
      capitalize(data.status),
    ].join(" · "),
    crossLinks: [
      financialAccountCrossLink(
        data.accountId,
        data.accountName ?? data.accountId,
      ),
    ],
    body: [
      {
        kind: "stats",
        stats: [
          { label: "Amount", value: formatCurrency(data.amount) },
          {
            label: "Date",
            value: data.postedDate ?? data.transactionDate ?? "—",
          },
          { label: "Purchases", value: data.allocations.length },
        ],
      },
    ],
  };
}

// ── Wishes ─────────────────────────────────────────────────────────────────

export function toWishCard(
  data: EntityDetailByEntity["wish"],
): ManifestCardProps {
  const priceRange = wishPriceRange(data.candidates);

  return {
    entity: "wish",
    routeParam: data.id,
    icon: <EntityIcon entity="wish" size={14} colored />,
    name: data.name,
    tag: "wish",
    identity: data.acquiredAt
      ? `Acquired ${formatDate(data.acquiredAt.toISOString())}`
      : "Open",
    body: [
      {
        kind: "stats",
        stats: [
          { label: "Candidates", value: data.candidates.length },
          {
            label: "Price range",
            value: priceRange
              ? formatCurrencyRange(priceRange.low, priceRange.high)
              : "—",
          },
        ],
      },
      ...(data.candidates.length > 0
        ? [
            {
              kind: "products" as const,
              products: data.candidates.map((candidate) => ({
                id: candidate.id,
                name: candidate.name,
                manufacturer: candidate.manufacturer,
              })),
            },
          ]
        : []),
    ],
  };
}

// ── Planting ────────────────────────────────────────────────────────────────

export function toPlantingCard(
  data: EntityDetailByEntity["planting"],
): ManifestCardProps {
  const thumbUrl = data.displayImages[0]?.url;

  return {
    entity: "planting",
    routeParam: data.id,
    icon: <EntityIcon entity="planting" size={14} colored />,
    name: data.displayName,
    tag: "planting",
    body: [
      ...(thumbUrl ? [{ kind: "thumb" as const, url: thumbUrl }] : []),
      {
        kind: "stats",
        stats: [
          { label: "Status", value: capitalize(data.status) },
          {
            label: "Location",
            value: data.locationId ? (
              <Row align="center" gap="xs">
                <EntityIcon entity="location" size={12} colored />
                {data.locationName ?? data.locationId}
              </Row>
            ) : (
              "—"
            ),
          },
        ],
      },
    ],
  };
}

// ── Garden entry ────────────────────────────────────────────────────────────

const GARDEN_ENTRY_PREVIEW_KIND_LABELS = {
  note: "Note",
  harvest: "Harvest",
} satisfies Record<GardenEntryKind, string>;

export function toGardenEntryCard(
  data: EntityDetailByEntity["gardenEntry"],
): ManifestCardProps {
  const thumbUrl = data.displayImages[0]?.url;

  return {
    entity: "gardenEntry",
    routeParam: data.id,
    icon: <EntityIcon entity="gardenEntry" size={14} colored />,
    name: data.displayName,
    tag: "gardenEntry",
    body: [
      ...(thumbUrl ? [{ kind: "thumb" as const, url: thumbUrl }] : []),
      {
        kind: "stats",
        stats: [
          {
            label: "Kind",
            value: GARDEN_ENTRY_PREVIEW_KIND_LABELS[data.kind] ?? data.kind,
          },
          { label: "Date", value: formatDate(data.observedOn) },
          {
            label: "Location",
            value: (
              <Row align="center" gap="xs">
                <EntityIcon entity="location" size={12} colored />
                {data.locationName}
              </Row>
            ),
          },
        ],
      },
    ],
  };
}

// ── Images ─────────────────────────────────────────────────────────────────

const imageAssociationCrossLink = (
  association: ImageAssociation,
): CrossLink => ({
  to: entities[association.entityType].routes.detail,
  params: entityDetailParams(association.entityId),
  icon: <EntityIcon entity={association.entityType} size={12} colored />,
  label: `${association.entityName} · ${association.role}`,
});

export function toImageCard(data: ImageWithEntity): ManifestCardProps {
  const dimensions =
    data.width !== null && data.height !== null
      ? `${data.width} × ${data.height}`
      : "—";

  return {
    entity: "image",
    routeParam: data.id,
    icon: <EntityIcon entity="image" size={14} colored />,
    name: data.filename,
    tag: "image",
    identity: data.status.toLowerCase(),
    crossLinks:
      data.associations.length > 0
        ? data.associations.map(imageAssociationCrossLink)
        : undefined,
    body: [
      ...(data.status === "UPLOADED"
        ? [{ kind: "thumb" as const, url: data.url }]
        : []),
      {
        kind: "stats",
        stats: [
          { label: "Dimensions", value: dimensions },
          { label: "Associations", value: data.associations.length },
        ],
      },
    ],
  };
}

// ── Generic dispatch ────────────────────────────────────────────────────────

type StandardPreviewEntity = Exclude<
  HoverPreviewEntity,
  "usda-food" | "cookbook" | "project" | "image"
>;

interface PreviewSpec<E extends StandardPreviewEntity> {
  label: string;
  toCard: (data: EntityDetailByEntity[E]) => ManifestCardProps;
}

type StandardPreviewProps = { id: string } & StandardPreviewPresentation;

function createPreviewContent<E extends StandardPreviewEntity>(
  entity: E,
  spec: PreviewSpec<E>,
): ComponentType<StandardPreviewProps> {
  return function TypedPreviewContent({
    id,
    showOpenAction,
    showIdentityHeader,
    onNameResolved,
    onRecordResolved,
  }) {
    const query = useQuery(entityDetailFor(entity).queryOptions(id));

    return (
      <PreviewQuery
        query={query}
        label={spec.label}
        onUnavailable={onRecordResolved}
      >
        {(data) => (
          <ResolvedManifestCard
            card={spec.toCard(data)}
            record={data}
            showOpenAction={showOpenAction}
            showIdentityHeader={showIdentityHeader}
            onNameResolved={onNameResolved}
            onRecordResolved={onRecordResolved}
          />
        )}
      </PreviewQuery>
    );
  };
}

const PREVIEW_CONTENT = {
  recipe: createPreviewContent("recipe", {
    label: "Recipe",
    toCard: toRecipeCard,
  }),
  ingredient: createPreviewContent("ingredient", {
    label: "Ingredient",
    toCard: toIngredientCard,
  }),
  product: createPreviewContent("product", {
    label: "Product",
    toCard: toProductCard,
  }),
  location: createPreviewContent("location", {
    label: "Location",
    toCard: toLocationCard,
  }),
  inventory: createPreviewContent("inventory", {
    label: "Inventory item",
    toCard: toInventoryCard,
  }),
  meal: createPreviewContent("meal", {
    label: "Meal",
    toCard: toMealCard,
  }),
  task: createPreviewContent("task", {
    label: "Task",
    toCard: toTaskCard,
  }),
  expense: createPreviewContent("expense", {
    label: "Expense",
    toCard: toExpenseCard,
  }),
  purchase: createPreviewContent("purchase", {
    label: "Purchase",
    toCard: toPurchaseCard,
  }),
  vendor: createPreviewContent("vendor", {
    label: "Vendor",
    toCard: toVendorCard,
  }),
  financialAccount: createPreviewContent("financialAccount", {
    label: "Financial account",
    toCard: toFinancialAccountCard,
  }),
  financialTransaction: createPreviewContent("financialTransaction", {
    label: "Financial transaction",
    toCard: toFinancialTransactionCard,
  }),
  wish: createPreviewContent("wish", {
    label: "Wish",
    toCard: toWishCard,
  }),
  planting: createPreviewContent("planting", {
    label: "Planting",
    toCard: toPlantingCard,
  }),
  gardenEntry: createPreviewContent("gardenEntry", {
    label: "Garden entry",
    toCard: toGardenEntryCard,
  }),
} satisfies Record<StandardPreviewEntity, ComponentType<StandardPreviewProps>>;

function GenericPreviewContent({
  entity,
  id,
  showOpenAction,
  showIdentityHeader,
  onNameResolved,
  onRecordResolved,
}: {
  entity: StandardPreviewEntity;
  id: string;
} & StandardPreviewPresentation) {
  const PreviewContent = PREVIEW_CONTENT[entity];
  return (
    <PreviewContent
      id={id}
      showOpenAction={showOpenAction}
      showIdentityHeader={showIdentityHeader}
      onNameResolved={onNameResolved}
      onRecordResolved={onRecordResolved}
    />
  );
}

function ProjectPreviewContent({
  id,
  showOpenAction,
  showIdentityHeader,
  onNameResolved,
  onRecordResolved,
}: {
  id: string;
} & StandardPreviewPresentation) {
  const projectId = parseShortcodeFor("project", id);
  const query = useQuery(entityDetailFor("project").queryOptions(id));
  const coverQuery = useQuery(
    image.projectSummaries.queryOptions({
      projectIds: [projectId],
    }),
  );
  const data = query.data
    ? {
        ...query.data,
        thumbUrl: coverQuery.data?.[projectId]?.[0]?.url,
      }
    : undefined;

  return (
    <PreviewQuery
      query={{
        data,
        isLoading: query.isLoading,
        isError: query.isError,
        refetch: query.refetch,
      }}
      label="Project"
      onUnavailable={onRecordResolved}
    >
      {(project) => (
        <ResolvedManifestCard
          card={toProjectCard(project)}
          record={query.data ?? project}
          showOpenAction={showOpenAction}
          showIdentityHeader={showIdentityHeader}
          onNameResolved={onNameResolved}
          onRecordResolved={onRecordResolved}
        />
      )}
    </PreviewQuery>
  );
}

function ImagePreviewContent({
  id,
  showOpenAction,
  showIdentityHeader,
  onNameResolved,
  onRecordResolved,
}: {
  id: string;
} & StandardPreviewPresentation) {
  const query = useQuery(image.detail.queryOptions({ id }));

  return (
    <PreviewQuery query={query} label="Image" onUnavailable={onRecordResolved}>
      {(data) => (
        <ResolvedManifestCard
          card={toImageCard(data)}
          record={data}
          showOpenAction={showOpenAction}
          showIdentityHeader={showIdentityHeader}
          onNameResolved={onNameResolved}
          onRecordResolved={onRecordResolved}
        />
      )}
    </PreviewQuery>
  );
}

export function EntityPreviewContent({
  entity,
  id,
  showOpenAction = true,
  showIdentityHeader = true,
  onNameResolved,
  onRecordResolved,
}: { entity: HoverPreviewEntity; id: string } & CompactPreviewPresentation) {
  // usda-food and cookbook fetch differently enough (fdc_id coercion and
  // specialized projections) to stay their own small components.
  // Every other entity is a uniform detail fetch, keyed here so switching
  // entities remounts rather than changing the hooks a single instance calls
  // (project's extra cover-image query is one more hook than the rest).
  if (entity === "usda-food")
    return (
      <UsdaFoodPreviewContent
        fdcId={fdcIdFromParam(id)}
        showOpenAction={showOpenAction}
        showIdentityHeader={showIdentityHeader}
        onNameResolved={onNameResolved}
        onRecordResolved={onRecordResolved}
      />
    );
  if (entity === "cookbook")
    return (
      <CookbookPreviewContent
        cookbookId={id}
        showOpenAction={showOpenAction}
        showIdentityHeader={showIdentityHeader}
        onNameResolved={onNameResolved}
        onRecordResolved={onRecordResolved}
      />
    );
  if (entity === "project")
    return (
      <ProjectPreviewContent
        id={id}
        showOpenAction={showOpenAction}
        showIdentityHeader={showIdentityHeader}
        onNameResolved={onNameResolved}
        onRecordResolved={onRecordResolved}
      />
    );
  if (entity === "image")
    return (
      <ImagePreviewContent
        id={id}
        showOpenAction={showOpenAction}
        showIdentityHeader={showIdentityHeader}
        onNameResolved={onNameResolved}
        onRecordResolved={onRecordResolved}
      />
    );
  return (
    <GenericPreviewContent
      key={entity}
      entity={entity}
      id={id}
      showOpenAction={showOpenAction}
      showIdentityHeader={showIdentityHeader}
      onNameResolved={onNameResolved}
      onRecordResolved={onRecordResolved}
    />
  );
}
