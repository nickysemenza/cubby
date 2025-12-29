import {
  Apple,
  Barcode,
  Carrot,
  ChefHat,
  Image,
  type LucideProps,
  MapPin,
  Package,
} from "lucide-react";
import { cn } from "~/lib/utils";
import type { Entity, EntityDefinition } from "./types";

// Entity colors using theme palette:
// - primary (terracotta): inventory - core entity
// - secondary (sage green): products, usda-food - items/data
// - accent (golden amber): ingredients - food-related
// - chart-4 (warm plum): recipes - creative
// - chart-5 (slate blue): locations - places
// - muted: images - supporting

export const entities: Record<Entity, EntityDefinition> = {
  ingredient: {
    label: "Ingredient",
    pluralLabel: "Ingredients",
    basePath: "ingredients",
    lucideIcon: Carrot,
    color: {
      bg: "bg-accent/20",
      text: "text-accent-foreground",
    },
    // Note: ingredient uses UnitMappingsTable (different from UnitMappingDisplay),
    // so unit-mappings is handled as a custom section
    detail: { commonSections: ["history"] },
    // Note: ingredient list has custom column order (selection first, createdAt in middle)
    // so we don't use standardColumns and define all columns explicitly
    list: {
      hasUnitMappings: true,
      defaultSort: "createdAt",
      standardColumns: [],
      sortableFields: ["createdAt", "name"],
    },
  },
  product: {
    label: "Product",
    pluralLabel: "Products",
    basePath: "products",
    lucideIcon: Barcode,
    color: {
      bg: "bg-secondary",
      text: "text-secondary-foreground",
    },
    detail: { commonSections: ["images", "unit-mappings", "history"] },
    list: {
      hasUnitMappings: true,
      defaultSort: "createdAt",
      standardColumns: ["image", "name", "createdAt"],
      sortableFields: [
        "createdAt",
        "name",
        "manufacturer",
        "model",
        "upc",
        "category",
        "ndb_number",
        "price",
      ],
    },
  },
  recipe: {
    label: "Recipe",
    pluralLabel: "Recipes",
    basePath: "recipes",
    lucideIcon: ChefHat,
    color: {
      bg: "bg-chart-4/20",
      text: "text-chart-4",
    },
    detail: { commonSections: ["images", "history"] },
    list: {
      defaultSort: "createdAt",
      standardColumns: ["image", "name", "createdAt"],
      sortableFields: ["createdAt", "name"],
    },
  },
  location: {
    label: "Location",
    pluralLabel: "Locations",
    basePath: "locations",
    lucideIcon: MapPin,
    color: {
      bg: "bg-chart-5/20",
      text: "text-chart-5",
    },
    // Note: location needs images in a specific position (before child locations),
    // so we handle it as a custom section and only use history from common
    detail: { commonSections: ["history"] },
    // Note: location list has custom column order (createdAt in middle, view toggle),
    // so we don't use standardColumns and define all columns explicitly
    list: {
      defaultSort: "createdAt",
      standardColumns: [],
      sortableFields: ["createdAt", "name", "type", "lastBulkInventory"],
    },
  },
  "inventory-item": {
    label: "Inventory Item",
    pluralLabel: "Inventory",
    basePath: "inventory",
    lucideIcon: Package,
    color: {
      bg: "bg-primary/15",
      text: "text-primary",
    },
    // Inventory items have a simple single-section detail page
    detail: { commonSections: ["history"] },
    // Inventory list has custom columns (image from product, amount instead of name)
    list: {
      defaultSort: "createdAt",
      standardColumns: [],
      sortableFields: ["createdAt", "amount", "valuation"],
    },
  },
  "usda-food": {
    label: "USDA Food",
    pluralLabel: "USDA Foods",
    basePath: "usda",
    lucideIcon: Apple,
    color: {
      bg: "bg-secondary",
      text: "text-secondary-foreground",
    },
    // USDA foods are read-only, no detail/list conventions needed
  },
  image: {
    label: "Image",
    pluralLabel: "Images",
    basePath: "images",
    lucideIcon: Image,
    color: {
      bg: "bg-muted",
      text: "text-muted-foreground",
    },
    detail: { commonSections: ["history"] },
    // Note: images use 'filename' not 'name', so we define columns explicitly in ImageList
    list: {
      defaultSort: "createdAt",
      standardColumns: ["createdAt"],
      sortableFields: ["createdAt", "updatedAt", "filename", "size", "status"],
    },
  },
};

/**
 * Get the list of server-sortable fields for an entity.
 * Used by both repos (for buildOrderBy) and UI (for enableSorting).
 */
export const getSortableFields = (entity: Entity): readonly string[] =>
  entities[entity].list?.sortableFields ?? ["createdAt", "name"];

/**
 * Render an entity's lucide icon. Useful for entities with hyphenated names
 * like "inventory-item" where JSX bracket notation doesn't work.
 *
 * Use `colored` prop to apply the entity's text color for visual identification.
 */
export const EntityIcon = ({
  entity,
  colored,
  className,
  ...props
}: { entity: Entity; colored?: boolean } & LucideProps) => {
  const def = entities[entity];
  return (
    <def.lucideIcon
      className={cn(colored && def.color.text, className)}
      {...props}
    />
  );
};
