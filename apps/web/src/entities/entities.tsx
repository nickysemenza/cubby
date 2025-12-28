import type { Entity, EntityDefinition } from "./types";

export const entities: Record<Entity, EntityDefinition> = {
  ingredient: {
    label: "Ingredient",
    pluralLabel: "Ingredients",
    basePath: "ingredients",
    icon: "🍽️",
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
    icon: "🛒",
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
      ],
    },
  },
  recipe: {
    label: "Recipe",
    pluralLabel: "Recipes",
    basePath: "recipes",
    icon: "📖",
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
    icon: "📍",
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
    icon: "📦",
    // Inventory items have a simple single-section detail page
    detail: { commonSections: ["history"] },
    // Inventory list has custom columns (image from product, amount instead of name)
    list: {
      defaultSort: "createdAt",
      standardColumns: [],
      sortableFields: ["createdAt", "amount"],
    },
  },
  "usda-food": {
    label: "USDA Food",
    pluralLabel: "USDA Foods",
    basePath: "usda",
    icon: "🍲",
    // USDA foods are read-only, no detail/list conventions needed
  },
  image: {
    label: "Image",
    pluralLabel: "Images",
    basePath: "images",
    icon: "🖼️",
    detail: { commonSections: ["history"] },
    list: {
      defaultSort: "createdAt",
      standardColumns: ["name", "createdAt"],
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
