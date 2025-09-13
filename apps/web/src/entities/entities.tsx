import { Entity } from "./types";

type EntityDefinition = {
  label: string;
  basePath: string;
  pluralLabel: string;
  shortcut?: string;
  icon: string;
};

export const entities: Record<Entity, EntityDefinition> = {
  ingredient: {
    label: "Ingredient",
    pluralLabel: "Ingredients",
    basePath: "ingredients",
    icon: "🍽️",
  },
  product: {
    label: "Product",
    pluralLabel: "Products",
    basePath: "products",
    icon: "🛒",
  },
  recipe: {
    label: "Recipe",
    pluralLabel: "Recipes",
    basePath: "recipes",
    icon: "📖",
  },
  location: {
    label: "Location",
    pluralLabel: "Locations",
    basePath: "locations",
    icon: "📍",
  },
  "inventory-item": {
    label: "Inventory Item",
    pluralLabel: "Inventory",
    basePath: "inventory",
    icon: "📦",
  },
  "usda-food": {
    label: "USDA Food",
    pluralLabel: "USDA Foods",
    basePath: "usda",
    icon: "🍲",
  },
  image: {
    label: "Image",
    pluralLabel: "Images",
    basePath: "images",
    icon: "🖼️",
  },
};
