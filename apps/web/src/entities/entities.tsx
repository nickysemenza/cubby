import {
  Apple,
  Barcode,
  BookOpen,
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
// - plum (warm plum): recipes - creative
// - slate (slate blue): locations - places
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
    routes: {
      detail: "/ingredients/$id",
      list: "/ingredients",
      new: "/ingredients/new",
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
    routes: {
      detail: "/products/$id",
      list: "/products",
      new: "/products/new",
    },
    detail: { commonSections: ["unit-mappings", "history"] },
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
      bg: "bg-plum/20",
      text: "text-plum",
    },
    routes: {
      detail: "/recipes/$id",
      list: "/recipes",
      new: "/recipes/new",
    },
    detail: { commonSections: ["images", "history"] },
    list: {
      defaultSort: "createdAt",
      standardColumns: ["image", "name", "createdAt"],
      sortableFields: ["createdAt", "name"],
    },
  },
  cookbook: {
    label: "Cookbook",
    pluralLabel: "Cookbooks",
    basePath: "cookbooks",
    lucideIcon: BookOpen,
    color: {
      bg: "bg-plum/20",
      text: "text-plum",
    },
    // Keyed by FK id (rename-safe); no generic list columns or "new" form
    // (cookbooks are created by EPUB import, not a create form).
    routes: {
      detail: "/cookbooks/$cookbookId",
      list: "/cookbooks",
    },
  },
  location: {
    label: "Location",
    pluralLabel: "Locations",
    basePath: "locations",
    lucideIcon: MapPin,
    color: {
      bg: "bg-slate/20",
      text: "text-slate",
    },
    routes: {
      detail: "/locations/$id",
      list: "/locations",
      new: "/locations/new",
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
  inventory: {
    label: "Inventory Item",
    pluralLabel: "Inventory",
    basePath: "inventory",
    lucideIcon: Package,
    color: {
      bg: "bg-primary/15",
      text: "text-primary",
    },
    routes: {
      detail: "/inventory/$id",
      list: "/inventory",
      new: "/inventory/new",
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
    routes: {
      detail: "/usda/$id",
      list: "/usda",
      // no "new" - USDA foods are read-only
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
    routes: {
      detail: "/images/$id",
      list: "/images",
      // no "new" - images are uploaded, not created via form
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
 * Render an entity's lucide icon. Useful for entities where you need
 * dynamic icon selection based on entity type.
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
