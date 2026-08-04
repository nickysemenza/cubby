import type { Entity } from "@cubby/schemas/entity";
import type { LocationType } from "@cubby/schemas/location";
import type { ProductCategory } from "@cubby/schemas/product";
import type { SearchableEntity, SearchResultItem } from "@cubby/schemas/search";
import { match } from "ts-pattern";
import { ProjectMark } from "~/app/projects/project-mark";
import { IconTile } from "~/components/ui/icon-tile";
import { Image } from "~/components/ui/image";
import { EntityIcon, entities, entityDetailParams } from "~/entities/entities";
import { cn, formatCurrency } from "~/lib/utils";
import { pushRecent } from "../command-menu/recents";
import { tryFormatAmount } from "../inventory/format-amount";
import {
  getLocationIcon,
  getLocationTypeColor,
} from "../locations/location-type-theme";
import { getCategoryColor, getCategoryIcon } from "../products/category-theme";

/** Map search result entityType to Entity for icons/colors */
export const entityTypeMap: Record<SearchableEntity, Entity> = {
  product: "product",
  recipe: "recipe",
  ingredient: "ingredient",
  cookbook: "cookbook",
  location: "location",
  inventory: "inventory",
  meal: "meal",
  project: "project",
  task: "task",
  vendor: "vendor",
  purchase: "purchase",
  financialAccount: "financialAccount",
  financialTransaction: "financialTransaction",
  expense: "expense",
  wish: "wish",
};

type SearchResultGroup = {
  entityType: SearchableEntity;
  label: string;
  items: SearchResultItem[];
};

export function groupSearchResults(
  results: readonly SearchResultItem[],
): SearchResultGroup[] {
  const groups: SearchResultGroup[] = [];
  const byType = new Map<SearchableEntity, SearchResultItem[]>();

  for (const item of results) {
    const existing = byType.get(item.entityType);
    if (existing) {
      existing.push(item);
    } else {
      const items = [item];
      byType.set(item.entityType, items);
      groups.push({
        entityType: item.entityType,
        label: entities[entityTypeMap[item.entityType]].pluralLabel,
        items,
      });
    }
  }

  return groups;
}

export function getSearchResultEntity(item: SearchResultItem): Entity {
  return entityTypeMap[item.entityType];
}

export function getSearchResultRoute(item: SearchResultItem) {
  const entity = getSearchResultEntity(item);
  return {
    to: entities[entity].routes.detail,
    params: entityDetailParams(item.id),
  };
}

export function rememberSearchResult(item: SearchResultItem): void {
  pushRecent({
    entityType: item.entityType,
    id: item.id,
    name: item.name,
  });
}

/** Render the appropriate icon for a search result item */
export function SearchResultItemIcon({
  item,
  className = "size-4 shrink-0",
}: {
  item: SearchResultItem;
  className?: string;
}) {
  const entity = entityTypeMap[item.entityType];

  if (item.entityType === "project") {
    return <ProjectMark icon={item.icon} className={className} />;
  }

  // Location with type hint
  if (item.entityType === "location" && item.typeHint) {
    const Icon = getLocationIcon(item.typeHint as LocationType);
    const color = getLocationTypeColor(item.typeHint as LocationType);
    return <Icon className={className} style={{ color }} />;
  }

  // Product/inventory with category hint
  if (
    (item.entityType === "product" || item.entityType === "inventory") &&
    item.typeHint
  ) {
    const Icon = getCategoryIcon(item.typeHint as ProductCategory);
    const color = getCategoryColor(item.typeHint as ProductCategory);
    return <Icon className={className} style={{ color }} />;
  }

  // Default entity icon
  return <EntityIcon entity={entity} colored className={className} />;
}

const mediaVariants = {
  command: {
    tile: "size-8 rounded",
    icon: "size-4 shrink-0",
    displayWidth: 64,
  },
  mobile: {
    tile: "size-11 rounded",
    icon: "size-5 shrink-0",
    displayWidth: 88,
  },
} as const;

export function SearchResultMedia({
  item,
  variant = "command",
}: {
  item: SearchResultItem;
  variant?: keyof typeof mediaVariants;
}) {
  const media = mediaVariants[variant];
  const entity = getSearchResultEntity(item);

  if (item.imageUrl) {
    return (
      <Image
        src={item.imageUrl}
        alt=""
        displayWidth={media.displayWidth}
        className={cn("shrink-0 object-cover", media.tile)}
      />
    );
  }

  return (
    <IconTile
      size={variant === "mobile" ? "lg" : "md"}
      className={cn(
        media.tile,
        entities[entity]?.color.bg ?? "bg-muted/50",
        entities[entity]?.color.text,
      )}
    >
      <SearchResultItemIcon item={item} className={media.icon} />
    </IconTile>
  );
}

/** Format enrichment info for display in search results */
export function getEnrichmentText(item: SearchResultItem): string | null {
  return match(item)
    .with({ entityType: "product" }, (item) => {
      const parts: string[] = [];
      if (item.price != null) parts.push(formatCurrency(item.price));
      if (item.stockCount != null && item.stockCount > 0)
        parts.push(`${item.stockCount} in stock`);
      return parts.length > 0 ? parts.join(" · ") : null;
    })
    .with({ entityType: "location" }, (item) => {
      const parts: string[] = [];
      if (item.itemCount != null && item.itemCount > 0)
        parts.push(`${item.itemCount} items`);
      if (item.childCount != null && item.childCount > 0)
        parts.push(`${item.childCount} sub`);
      return parts.length > 0 ? parts.join(" · ") : null;
    })
    .with({ entityType: "inventory" }, (item) =>
      item.amount ? tryFormatAmount(item.amount) : null,
    )
    .with({ entityType: "recipe" }, (item) =>
      item.ingredientCount != null && item.ingredientCount > 0
        ? `${item.ingredientCount} ingredients`
        : null,
    )
    .with({ entityType: "ingredient" }, (item) =>
      item.recipeCount != null && item.recipeCount > 0
        ? `in ${item.recipeCount} recipes`
        : null,
    )
    .with({ entityType: "cookbook" }, (item) =>
      item.recipeCount != null && item.recipeCount > 0
        ? `${item.recipeCount} recipes`
        : null,
    )
    .with({ entityType: "meal" }, (item) =>
      item.recipeCount != null && item.recipeCount > 0
        ? `${item.recipeCount} recipes`
        : null,
    )
    .with({ entityType: "project" }, (item) =>
      item.spent != null && item.spent > 0
        ? `${formatCurrency(item.spent)} spent`
        : null,
    )
    .with({ entityType: "task" }, (item) => item.projectName)
    .with({ entityType: "vendor" }, (item) => {
      const parts: string[] = [];
      if (item.purchaseCount != null && item.purchaseCount > 0)
        parts.push(`${item.purchaseCount} purchases`);
      if (item.spend != null && item.spend !== 0)
        parts.push(`${formatCurrency(item.spend)} spent`);
      return parts.length > 0 ? parts.join(" · ") : null;
    })
    .with({ entityType: "purchase" }, (item) => {
      const parts: string[] = [];
      if (item.expenseCount != null && item.expenseCount > 0)
        parts.push(`${item.expenseCount} expenses`);
      if (item.expenseTotal != null)
        parts.push(formatCurrency(item.expenseTotal));
      return parts.length > 0 ? parts.join(" · ") : null;
    })
    .with({ entityType: "financialAccount" }, (item) => {
      const parts: string[] = [];
      if (item.provisional) parts.push("provisional");
      if (item.transactionCount != null && item.transactionCount > 0)
        parts.push(`${item.transactionCount} transactions`);
      return parts.length > 0 ? parts.join(" · ") : null;
    })
    .with({ entityType: "financialTransaction" }, (item) => {
      const parts: string[] = [];
      if (item.amount != null) parts.push(formatCurrency(item.amount));
      if (item.status) parts.push(item.status);
      return parts.length > 0 ? parts.join(" · ") : null;
    })
    .with({ entityType: "expense" }, (item) => {
      const parts: string[] = [];
      if (item.cost != null) parts.push(formatCurrency(item.cost));
      if (item.projectName) parts.push(item.projectName);
      return parts.length > 0 ? parts.join(" · ") : null;
    })
    .with({ entityType: "wish" }, (item) => {
      const parts: string[] = [];
      if (item.candidateCount > 0)
        parts.push(
          `${item.candidateCount} candidate${item.candidateCount === 1 ? "" : "s"}`,
        );
      if (item.acquiredAt) parts.push("acquired");
      return parts.length > 0 ? parts.join(" · ") : null;
    })
    .exhaustive();
}

const matchKindLabel = {
  exact: "exact",
  substring: "contains",
  trigram: "fuzzy",
  semantic: "semantic",
  hybrid: "hybrid",
} as const satisfies Record<NonNullable<SearchResultItem["matchKind"]>, string>;

export function getSearchMatchText(item: SearchResultItem): string | null {
  if (!item.matchKind) return null;
  const parts: string[] = [matchKindLabel[item.matchKind]];
  if (item.matchTerms?.length) {
    parts.push(`matched ${item.matchTerms.slice(0, 3).join(", ")}`);
  } else if (item.matchKind === "semantic") {
    parts.push("vector similarity");
  } else if (item.matchReason) {
    parts.push(item.matchReason);
  }
  if (item.score != null) parts.push(`${Math.round(item.score)} pts`);
  return parts.join(" · ");
}
