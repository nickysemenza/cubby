import { z } from "zod";
import { searchableEntities, type ShortcodeEntity } from "./entity-manifest";
import { anyShortcodeSchema } from "./identifiers";

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

/** Search type options for filtering (includes "all"). */
export const searchTypeOptions = ["all", ...searchableEntities] as const;
export const searchTypeSchema = z.enum(searchTypeOptions);
export type SearchType = z.infer<typeof searchTypeSchema>;

/**
 * The shared lexical-search request. Entity scopes are an array so Explore,
 * MCP, and pickers can ask for the same constrained result set in one call.
 */
export const searchQueryInputFields = {
  query: z.string().trim().min(1).max(100),
  entityTypes: z
    .array(searchableEntitySchema)
    .min(1)
    .max(searchableEntities.length)
    .optional()
    .describe("Restrict results to these searchable entity types."),
  limit: z.number().int().min(1).max(50).default(5),
};
export const searchQueryInputSchema = z.object(searchQueryInputFields);
export type SearchQueryInput = z.infer<typeof searchQueryInputSchema>;

/** Allowlisted entity-to-entity similarity directions. */
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
  limit: z.number().int().min(1).max(25).default(5),
});
export type SimilarEntitiesInput = z.infer<typeof similarEntitiesInputSchema>;

export const searchMatchKindSchema = z.enum([
  "exact",
  "prefix",
  "text",
  "fuzzy",
  "semantic",
]);
export type SearchMatchKind = z.infer<typeof searchMatchKindSchema>;

export const searchMatchFieldSchema = z.enum([
  "shortcode",
  "title",
  "alias",
  "keyword",
  "body",
  "embedding",
]);
export type SearchMatchField = z.infer<typeof searchMatchFieldSchema>;

/** A compact, public search result. `id` is always a public shortcode. */
export const searchHitSchema = z.object({
  id: searchableEntityIdSchema,
  entityType: searchableEntitySchema,
  title: z.string(),
  subtitle: z.string().nullable(),
  typeHint: z.string().nullable(),
  imageUrl: z.string().nullable(),
  matchKind: searchMatchKindSchema,
  matchField: searchMatchFieldSchema,
  matchReason: z.string(),
  matchTerms: z.array(z.string()),
});
export type SearchHit = z.infer<typeof searchHitSchema>;

export const searchHitsOut = z.array(searchHitSchema);

/** Semantic results are separate so they cannot reorder lexical hits. */
export const relatedSearchOutSchema = z.object({
  status: z.enum(["ready", "unavailable"]),
  results: z.array(searchHitSchema),
});
export type RelatedSearchOut = z.infer<typeof relatedSearchOutSchema>;

/** One neighbour of the seed entity; higher similarity means closer. */
export const similarEntityResultSchema = z.object({
  similarity: z.number(),
  entity: searchHitSchema,
});
export type SimilarEntityResult = z.infer<typeof similarEntityResultSchema>;

export const similarEntitiesOut = z.object({
  source: searchableEntityRefSchema,
  results: z.array(similarEntityResultSchema),
});
export type SimilarEntitiesOut = z.infer<typeof similarEntitiesOut>;

/** Debug keeps the three-stage view, but exposes only public hit fields. */
export const searchDebugOutSchema = z.object({
  query: z.string(),
  lexical: z.array(searchHitSchema),
  semantic: z.array(searchHitSchema),
  results: z.array(searchHitSchema),
});
export type SearchDebugOut = z.infer<typeof searchDebugOutSchema>;
