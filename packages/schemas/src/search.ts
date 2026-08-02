import { z } from "zod";
import { amount } from "./codec";
import { searchableEntities, type ShortcodeEntity } from "./entity-manifest";
import {
  anyShortcodeSchema,
  cookbookShortcode,
  expenseShortcode,
  financialAccountShortcode,
  financialTransactionShortcode,
  ingredientShortcode,
  inventoryShortcode,
  locationShortcode,
  mealShortcode,
  productShortcode,
  projectShortcode,
  purchaseShortcode,
  recipeShortcode,
  taskShortcode,
  vendorShortcode,
} from "./identifiers";

export { searchableEntities } from "./entity-manifest";

export const searchableEntitySchema = z.enum(searchableEntities);
export type SearchableEntity = z.infer<typeof searchableEntitySchema>;

const searchableEntityTypes = searchableEntities as unknown as [
  ShortcodeEntity,
  ...ShortcodeEntity[],
];
export const searchableEntityIdSchema = anyShortcodeSchema(
  searchableEntityTypes,
);

export const searchableEntityRefFields = {
  entityType: searchableEntitySchema,
  entityId: searchableEntityIdSchema,
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
  entityType: searchableEntitySchema
    .optional()
    .describe("Restrict results to one searchable entity type."),
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
 * queryable, but only these have a meaning worth surfacing (map an expense to
 * the product it bought, find duplicate products/ingredients, find related
 * recipes). Callers pick a key; they can't compose their own combination.
 */
export const similarEntityPairKeys = [
  "expense_to_product",
  "product_to_product",
  "ingredient_to_ingredient",
  "recipe_to_recipe",
] as const;
export const similarEntityPairSchema = z.enum(similarEntityPairKeys);
export type SimilarEntityPair = z.infer<typeof similarEntityPairSchema>;

export const similarEntityPairs = {
  expense_to_product: { source: "expense", target: "product" },
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
  sourceId: searchableEntityIdSchema.describe(
    "Shortcode of the seed entity (the pair's source type)",
  ),
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
  id: productShortcode,
  entityType: z.literal("product"),
  price: z.number().nullable(),
  stockCount: z.number().nullable(),
});

const locationResult = z.object({
  ...searchResultBaseFields,
  id: locationShortcode,
  entityType: z.literal("location"),
  itemCount: z.number().nullable(),
  childCount: z.number().nullable(),
});

const inventoryResult = z.object({
  ...searchResultBaseFields,
  id: inventoryShortcode,
  entityType: z.literal("inventory"),
  amount: amount.nullable(),
});

const recipeResult = z.object({
  ...searchResultBaseFields,
  id: recipeShortcode,
  entityType: z.literal("recipe"),
  ingredientCount: z.number().nullable(),
});

const ingredientResult = z.object({
  ...searchResultBaseFields,
  id: ingredientShortcode,
  entityType: z.literal("ingredient"),
  recipeCount: z.number().nullable(),
});

const cookbookResult = z.object({
  ...searchResultBaseFields,
  id: cookbookShortcode,
  entityType: z.literal("cookbook"),
  /** Recipes actually imported from the book (live rows). */
  recipeCount: z.number().nullable(),
  authors: z.array(z.string()),
});

const mealResult = z.object({
  ...searchResultBaseFields,
  id: mealShortcode,
  entityType: z.literal("meal"),
  /** Calendar day, "YYYY-MM-DD" (the Meal.date column is day-granular). */
  date: z.string().nullable(),
  recipeCount: z.number().nullable(),
});

const projectResult = z.object({
  ...searchResultBaseFields,
  id: projectShortcode,
  entityType: z.literal("project"),
  status: z.string().nullable(),
  spent: z.number().nullable(),
});

const taskResult = z.object({
  ...searchResultBaseFields,
  id: taskShortcode,
  entityType: z.literal("task"),
  status: z.string().nullable(),
  projectName: z.string().nullable(),
});

const expenseResult = z.object({
  ...searchResultBaseFields,
  id: expenseShortcode,
  entityType: z.literal("expense"),
  cost: z.number().nullable(),
  projectName: z.string().nullable(),
});

const vendorResult = z.object({
  ...searchResultBaseFields,
  id: vendorShortcode,
  entityType: z.literal("vendor"),
  purchaseCount: z.number().nullable(),
  spend: z.number().nullable(),
});

const purchaseResult = z.object({
  ...searchResultBaseFields,
  id: purchaseShortcode,
  entityType: z.literal("purchase"),
  orderId: z.string().nullable(),
  date: z.string().nullable(),
  expenseCount: z.number().nullable(),
  expenseTotal: z.number().nullable(),
});

const financialAccountResult = z.object({
  ...searchResultBaseFields,
  id: financialAccountShortcode,
  entityType: z.literal("financialAccount"),
  identityKind: z.string().nullable(),
  provisional: z.boolean(),
  transactionCount: z.number().nullable(),
});

const financialTransactionResult = z.object({
  ...searchResultBaseFields,
  id: financialTransactionShortcode,
  entityType: z.literal("financialTransaction"),
  amount: z.number().nullable(),
  status: z.string().nullable(),
  kind: z.string().nullable(),
  accountName: z.string().nullable(),
  transactionDate: z.string().nullable(),
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
  vendorResult,
  purchaseResult,
  financialAccountResult,
  financialTransactionResult,
  expenseResult,
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
export type VendorSearchResult = z.infer<typeof vendorResult>;
export type PurchaseSearchResult = z.infer<typeof purchaseResult>;
export type FinancialAccountSearchResult = z.infer<
  typeof financialAccountResult
>;
export type FinancialTransactionSearchResult = z.infer<
  typeof financialTransactionResult
>;
export type ExpenseSearchResult = z.infer<typeof expenseResult>;
