import type { Entity } from "@cubby/schemas/entity";
import type { LocationType } from "@cubby/schemas/location";
import type { ProductCategory } from "@cubby/schemas/product";
import type { SearchableEntity, SearchResultItem } from "@cubby/schemas/search";
import { match } from "ts-pattern";
import { EntityIcon } from "~/entities/entities";
import { formatCurrency } from "~/lib/utils";
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
  location: "location",
  inventory: "inventory",
};

/** Render the appropriate icon for a search result item */
export function SearchResultItemIcon({
  item,
  className = "h-4 w-4 shrink-0",
}: {
  item: SearchResultItem;
  className?: string;
}) {
  const entity = entityTypeMap[item.entityType];

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
    .exhaustive();
}
