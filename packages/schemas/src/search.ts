import { z } from "zod";
import { backgroundBatchRefSchema } from "./background-jobs";
import { searchableEntities, type ShortcodeEntity } from "./entity-manifest";
import { anyShortcodeSchema } from "./identifiers";
import {
  activeRelatednessPairKeys,
  embeddingReadinessSchema,
  relatednessPairRegistry,
} from "./relatedness";

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

export const similarEntityPairKeys = activeRelatednessPairKeys;
export const similarEntityPairSchema = z.enum(similarEntityPairKeys);
export type SimilarEntityPair = z.infer<typeof similarEntityPairSchema>;

export const similarEntityPairs = Object.fromEntries(
  similarEntityPairKeys.map((key) => [key, relatednessPairRegistry[key]]),
) as unknown as Record<
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

export const requestEmbeddingRefreshInputSchema = z.object({
  entityType: searchableEntitySchema,
  entityId: searchableEntityIdSchema,
});
export type RequestEmbeddingRefreshInput = z.infer<
  typeof requestEmbeddingRefreshInputSchema
>;

export const requestEmbeddingRefreshOutSchema = z.object({
  batchId: z.string(),
  totalJobs: z.number().int().nonnegative(),
});
export type RequestEmbeddingRefreshOut = z.infer<
  typeof requestEmbeddingRefreshOutSchema
>;

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

/**
 * A compact, public search result. `id` is always a public shortcode.
 *
 * Deliberately NOT a per-entity discriminated union: every hit carries the same
 * six presentation fields, and each entity's projection decides which of them
 * are null. The coverage that keeps a new `searchable: true` entity from
 * silently dropping out of global search therefore lives with the projections,
 * not here — see the `satisfies Record<SearchableEntity, SQL>` branch map in
 * `apps/web/src/server/repo/search-document.ts` and `searchDocumentBuilders`
 * beside it, plus `entityTypeMap` in `search/search-utils.tsx` for the client
 * route/icon side.
 */
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

/** Public, aggregate-only health for the private SearchDocument projection. */
export const searchDocumentHealthSchema = z.object({
  missing: z.number().int().nonnegative(),
  orphaned: z.number().int().nonnegative(),
  stale: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export type SearchDocumentHealth = z.infer<typeof searchDocumentHealthSchema>;

export const searchDocumentMaintenanceSchema = z.object({
  state: z.enum(["never-run", "running", "completed", "failed"]),
  batchId: z.string().nullable(),
  findings: searchDocumentHealthSchema,
  repaired: z.object({
    queued: z.number().int().nonnegative(),
    retired: z.number().int().nonnegative(),
  }),
  reused: z.boolean(),
  completedAt: z.date().nullable(),
});
export type SearchDocumentMaintenance = z.infer<
  typeof searchDocumentMaintenanceSchema
>;

export const repairSearchDocumentsOutSchema = z.object({
  batch: backgroundBatchRefSchema,
  reused: z.boolean(),
});
export type RepairSearchDocumentsOut = z.infer<
  typeof repairSearchDocumentsOutSchema
>;

/** Semantic results are separate so they cannot reorder lexical hits. */
export const relatedSearchOutSchema = z.object({
  status: z.enum(["ready", "unavailable"]),
  results: z.array(searchHitSchema),
});
export type RelatedSearchOut = z.infer<typeof relatedSearchOutSchema>;

export const similarEntityResultSchema = z.object({
  similarity: z.number(),
  entity: searchHitSchema,
});
export type SimilarEntityResult = z.infer<typeof similarEntityResultSchema>;

export const similarEntitiesOut = z.object({
  source: searchableEntityRefSchema,
  status: embeddingReadinessSchema,
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
