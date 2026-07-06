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

export const searchableEntityRefFields = {
  entityType: searchableEntitySchema,
  entityId: z.string(),
};

export const searchableEntityRefSchema = z.object(searchableEntityRefFields);
export type SearchableEntityRef = z.infer<typeof searchableEntityRefSchema>;

/** Search type options for filtering (includes "all") */
export const searchTypeOptions = ["all", ...searchableEntities] as const;
export const searchTypeSchema = z.enum(searchTypeOptions);
export type SearchType = z.infer<typeof searchTypeSchema>;

export const globalSearchInputSchema = z.object({
  query: z.string().min(1).max(100),
  limit: z.number().min(1).max(50).default(5),
  /**
   * "lexical" skips the semantic (embedding + pgvector) path so the fast
   * ilike results can render immediately; the command palette pairs it with
   * a second "hybrid" request that merges semantic results when they land.
   */
  mode: z.enum(["lexical", "hybrid"]).default("hybrid"),
});

export const searchMatchKindSchema = z.enum([
  "exact",
  "substring",
  "trigram",
  "semantic",
  "hybrid",
]);
export type SearchMatchKind = z.infer<typeof searchMatchKindSchema>;

const searchResultBaseFields = {
  id: z.string(),
  name: z.string(),
  subtitle: z.string().nullable(),
  typeHint: z.string().nullable(),
  imageUrl: z.string().nullable(),
  createdAt: z.coerce.date(),
  score: z.number().optional(),
  matchKind: searchMatchKindSchema.optional(),
  matchReason: z.string().optional(),
  matchTerms: z.array(z.string()).optional(),
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

export const semanticBackfillInputSchema = z.object({
  entityTypes: z.array(searchableEntitySchema).optional(),
  limit: z.number().min(1).max(500).default(100),
});

export const semanticBackfillOutSchema = z.object({
  scanned: z.number().int().nonnegative(),
  embedded: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});

export const searchDebugInputSchema = globalSearchInputSchema;
export const searchDebugOutSchema = z.object({
  query: z.string(),
  lexical: z.array(searchResultItemSchema),
  semantic: z.array(searchResultItemSchema),
  results: z.array(searchResultItemSchema),
});
export type SearchDebugOut = z.infer<typeof searchDebugOutSchema>;

// Export individual variants for repo type hints
export type ProductSearchResult = z.infer<typeof productResult>;
export type LocationSearchResult = z.infer<typeof locationResult>;
export type InventorySearchResult = z.infer<typeof inventoryResult>;
export type RecipeSearchResult = z.infer<typeof recipeResult>;
export type IngredientSearchResult = z.infer<typeof ingredientResult>;
