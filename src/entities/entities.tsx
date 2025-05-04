import { Entity } from "./types";

type EntityDefinition = {
  name: Entity;
  label: string;
  basePath: string;
  pluralLabel: string;
  shortcut?: string;
  icon: string;
};
export const entities: EntityDefinition[] = [
  {
    name: "ingredient",
    label: "Ingredient",
    pluralLabel: "Ingredients",
    basePath: "ingredients",
    icon: "🍽️",
  },
  {
    name: "product",
    label: "Product",
    pluralLabel: "Products",
    basePath: "products",
    icon: "🛒",
  },
  {
    name: "recipe",
    label: "Recipe",
    pluralLabel: "Recipes",
    basePath: "recipes",
    icon: "📖",
  },
  {
    name: "location",
    label: "Location",
    pluralLabel: "Locations",
    basePath: "locations",
    icon: "📍",
  },
  {
    name: "inventory-item",
    label: "Inventory Item",
    pluralLabel: "Inventory",
    basePath: "inventory",
    icon: "📦",
  },
];
