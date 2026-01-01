import { EntityIcon } from "~/entities/entities";
import type { Entity } from "~/entities/types";
import { formatCurrency } from "~/lib/utils";
import type { LocationType } from "~/schemas/location";
import type { ProductCategory } from "~/schemas/product";
import type { SearchableEntity, SearchResultItem } from "~/schemas/search";
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
  switch (item.entityType) {
    case "product": {
      const parts: string[] = [];
      if (item.price != null) parts.push(formatCurrency(item.price));
      if (item.stockCount != null && item.stockCount > 0)
        parts.push(`${item.stockCount} in stock`);
      return parts.length > 0 ? parts.join(" · ") : null;
    }
    case "location": {
      const parts: string[] = [];
      if (item.itemCount != null && item.itemCount > 0)
        parts.push(`${item.itemCount} items`);
      if (item.childCount != null && item.childCount > 0)
        parts.push(`${item.childCount} sub`);
      return parts.length > 0 ? parts.join(" · ") : null;
    }
    case "inventory":
      if (item.amount) return tryFormatAmount(item.amount);
      return null;
    case "recipe":
      if (item.ingredientCount != null && item.ingredientCount > 0)
        return `${item.ingredientCount} ingredients`;
      return null;
    case "ingredient":
      if (item.recipeCount != null && item.recipeCount > 0)
        return `in ${item.recipeCount} recipes`;
      return null;
  }
}
