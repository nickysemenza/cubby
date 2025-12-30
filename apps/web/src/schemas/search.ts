import { z } from "zod";
import { amount } from "~/codec/codec";
import type { Entity } from "~/entities/types";

/** Searchable entities - subset of Entity excluding "usda-food" and "image" */
const searchableEntities = [
  "product",
  "recipe",
  "ingredient",
  "location",
  "inventory-item",
] as const satisfies readonly Entity[];

export const searchableEntitySchema = z.enum(searchableEntities);
export type SearchableEntity = z.infer<typeof searchableEntitySchema>;

// Base fields shared by all search results
const baseSearchResult = z.object({
  id: z.string(),
  name: z.string(),
  subtitle: z.string().nullable(),
  typeHint: z.string().nullable(),
});

// Per-entity result schemas
const productResult = baseSearchResult.extend({
  entityType: z.literal("product"),
  price: z.number().nullable(),
  stockCount: z.number().nullable(),
});

const locationResult = baseSearchResult.extend({
  entityType: z.literal("location"),
  itemCount: z.number().nullable(),
  childCount: z.number().nullable(),
});

const inventoryResult = baseSearchResult.extend({
  entityType: z.literal("inventory-item"),
  amount: amount.nullable(),
});

const recipeResult = baseSearchResult.extend({
  entityType: z.literal("recipe"),
  ingredientCount: z.number().nullable(),
});

const ingredientResult = baseSearchResult.extend({
  entityType: z.literal("ingredient"),
  recipeCount: z.number().nullable(),
});

export const searchResultItemSchema = z.discriminatedUnion("entityType", [
  productResult,
  locationResult,
  inventoryResult,
  recipeResult,
  ingredientResult,
]);
export type SearchResultItem = z.infer<typeof searchResultItemSchema>;

// Export individual variants for repo type hints
export type ProductSearchResult = z.infer<typeof productResult>;
export type LocationSearchResult = z.infer<typeof locationResult>;
export type InventorySearchResult = z.infer<typeof inventoryResult>;
export type RecipeSearchResult = z.infer<typeof recipeResult>;
export type IngredientSearchResult = z.infer<typeof ingredientResult>;
