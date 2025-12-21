import { type Entity, type EntityDefinition } from "./types";

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
    },
  },
};
