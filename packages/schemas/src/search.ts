import { z } from "zod";
import { amount } from "./codec";
import { searchableEntities } from "./entity-manifest";

export { searchableEntities } from "./entity-manifest";

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

/**
 * Allowlisted entity-to-entity similarity directions.
 *
 * Deliberately a fixed set rather than an arbitrary source→target product:
 * every embedding lives in one shared space, so any pair is *technically*
 * queryable, but only these have a meaning worth surfacing (map a purchase to
 * the product it bought, find duplicate products/ingredients, find related
 * recipes). Callers pick a key; they can't compose their own combination.
 */
export const similarEntityPairKeys = [
  "purchase_to_product",
  "product_to_product",
  "ingredient_to_ingredient",
  "recipe_to_recipe",
] as const;
export const similarEntityPairSchema = z.enum(similarEntityPairKeys);
export type SimilarEntityPair = z.infer<typeof similarEntityPairSchema>;

export const similarEntityPairs = {
  purchase_to_product: { source: "purchase", target: "product" },
  product_to_product: { source: "product", target: "product" },
  ingredient_to_ingredient: { source: "ingredient", target: "ingredient" },
  recipe_to_recipe: { source: "recipe", target: "recipe" },
} as const satisfies Record<
  SimilarEntityPair,
  { source: SearchableEntity; target: SearchableEntity }
>;

export const similarEntitiesInputSchema = z.object({
  pair: similarEntityPairSchema.describe(
    "Which direction to search: <sourceType>_to_<targetType>",
  ),
  sourceId: z.uuid().describe("ID of the seed entity (the pair's source type)"),
  limit: z.number().min(1).max(25).default(5),
});
export type SimilarEntitiesInput = z.infer<typeof similarEntitiesInputSchema>;

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

const cookbookResult = z.object({
  ...searchResultBaseFields,
  entityType: z.literal("cookbook"),
  /** Recipes actually imported from the book (live rows). */
  recipeCount: z.number().nullable(),
  authors: z.array(z.string()),
});

const mealResult = z.object({
  ...searchResultBaseFields,
  entityType: z.literal("meal"),
  /** Calendar day, "YYYY-MM-DD" (the Meal.date column is day-granular). */
  date: z.string().nullable(),
  recipeCount: z.number().nullable(),
});

const projectResult = z.object({
  ...searchResultBaseFields,
  entityType: z.literal("project"),
  status: z.string().nullable(),
  spent: z.number().nullable(),
});

const taskResult = z.object({
  ...searchResultBaseFields,
  entityType: z.literal("task"),
  status: z.string().nullable(),
  projectName: z.string().nullable(),
});

const purchaseResult = z.object({
  ...searchResultBaseFields,
  entityType: z.literal("purchase"),
  cost: z.number().nullable(),
  projectName: z.string().nullable(),
});

export const searchResultItemSchema = z.discriminatedUnion("entityType", [
  productResult,
  locationResult,
  inventoryResult,
  recipeResult,
  ingredientResult,
  cookbookResult,
  mealResult,
  projectResult,
  taskResult,
  purchaseResult,
]);
export type SearchResultItem = z.infer<typeof searchResultItemSchema>;

export const globalSearchOut = z.array(searchResultItemSchema);

/**
 * One neighbour of the seed entity. `similarity` is cosine similarity in
 * [-1, 1] (higher = closer) — it *ranks* candidates, it does not verify them;
 * see the find_similar_entities tool description.
 */
export const similarEntityResultSchema = z.object({
  similarity: z.number(),
  entity: searchResultItemSchema,
});
export type SimilarEntityResult = z.infer<typeof similarEntityResultSchema>;

export const similarEntitiesOut = z.object({
  /** Echoes the resolved seed so the caller can confirm what was matched against. */
  source: searchableEntityRefSchema,
  results: z.array(similarEntityResultSchema),
});
export type SimilarEntitiesOut = z.infer<typeof similarEntitiesOut>;

export const semanticBackfillInputSchema = z.object({
  entityTypes: z.array(searchableEntitySchema).optional(),
  limit: z.number().min(1).max(500).default(100),
});

export const semanticBackfillOutSchema = z.object({
  scanned: z.number().int().nonnegative(),
  embedded: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});

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
export type CookbookSearchResult = z.infer<typeof cookbookResult>;
export type MealSearchResult = z.infer<typeof mealResult>;
export type ProjectSearchResult = z.infer<typeof projectResult>;
export type TaskSearchResult = z.infer<typeof taskResult>;
export type PurchaseSearchResult = z.infer<typeof purchaseResult>;
