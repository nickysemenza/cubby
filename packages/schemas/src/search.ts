import { z } from "zod";
import { amount } from "./codec";
import type { Entity } from "./entity";

/** Searchable entities - subset of Entity excluding "usda-food" and "image" */
export const searchableEntities = [
  "product",
  "recipe",
  "ingredient",
  "location",
  "inventory",
] as const satisfies readonly Entity[];

export const searchableEntitySchema = z.enum(searchableEntities);
export type SearchableEntity = z.infer<typeof searchableEntitySchema>;

/** Search type options for filtering (includes "all") */
export const searchTypeOptions = ["all", ...searchableEntities] as const;
export const searchTypeSchema = z.enum(searchTypeOptions);
export type SearchType = z.infer<typeof searchTypeSchema>;

export const globalSearchInputSchema = z.object({
  query: z.string().min(1).max(100),
  limit: z.number().min(1).max(50).default(5),
});

const searchResultBaseFields = {
  id: z.string(),
  name: z.string(),
  subtitle: z.string().nullable(),
  typeHint: z.string().nullable(),
  imageUrl: z.string().nullable(),
  createdAt: z.coerce.date(),
};

// Per-entity result schemas
const productResult = z.object({
  ...searchResultBaseFields,
  entityType: z.literal("product"),
  price: z.number().nullable(),
  stockCount: z.number().nullable(),
});

const locationResult = z.object({
  ...searchResultBaseFields,
  entityType: z.literal("location"),
  itemCount: z.number().nullable(),
  childCount: z.number().nullable(),
});

const inventoryResult = z.object({
  ...searchResultBaseFields,
  entityType: z.literal("inventory"),
  amount: amount.nullable(),
});

const recipeResult = z.object({
  ...searchResultBaseFields,
  entityType: z.literal("recipe"),
  ingredientCount: z.number().nullable(),
});

const ingredientResult = z.object({
  ...searchResultBaseFields,
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

export const globalSearchOut = z.array(searchResultItemSchema);

// Export individual variants for repo type hints
export type ProductSearchResult = z.infer<typeof productResult>;
export type LocationSearchResult = z.infer<typeof locationResult>;
export type InventorySearchResult = z.infer<typeof inventoryResult>;
export type RecipeSearchResult = z.infer<typeof recipeResult>;
export type IngredientSearchResult = z.infer<typeof ingredientResult>;
