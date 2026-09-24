import { z } from "zod";
import { inventoryPlacementValues } from "@cubby/shared";
import { amount } from "./codec";
import {
  embeddableEntities,
  type EmbeddableEntity,
  searchableEntities,
  type ShortcodeEntity,
} from "./entity-manifest";
import {
  anyShortcodeSchema,
  inventoryShortcode,
  locationShortcode,
  nonEmptyTuple,
} from "./identifiers";
import {
  activeRelatednessPairKeys,
  embeddingReadinessSchema,
  relatednessPairRegistry,
} from "./relatedness";

export { embeddableEntities, searchableEntities } from "./entity-manifest";
export type { EmbeddableEntity } from "./entity-manifest";

export const searchableEntitySchema = z.enum(searchableEntities);
export type SearchableEntity = z.infer<typeof searchableEntitySchema>;

export const embeddableEntitySchema = z.enum(embeddableEntities);
export const isEmbeddableEntity = (
  entityType: SearchableEntity,
): entityType is EmbeddableEntity =>
  embeddableEntitySchema.safeParse(entityType).success;

const searchableEntityTypes =
  nonEmptyTuple<ShortcodeEntity>(searchableEntities);
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
);

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

/**
 * An explicit refresh is accepted, not completed: the embedding runs on the
 * queue and the entity's readiness (`relatedness.product`) reports the result.
 */
export const requestEmbeddingRefreshOutSchema = z.object({
  accepted: z.literal(true),
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
  locationPath: z
    .array(z.object({ id: z.string(), name: z.string() }))
    .optional(),
  matchKind: searchMatchKindSchema,
  matchField: searchMatchFieldSchema,
  matchReason: z.string(),
  matchTerms: z.array(z.string()),
});
export type SearchHit = z.infer<typeof searchHitSchema>;

export const searchHitsOut = z.array(searchHitSchema);

/** A routable entity projection without a claim that it matched the query. */
export const searchDestinationSchema = searchHitSchema.pick({
  id: true,
  entityType: true,
  title: true,
  subtitle: true,
  typeHint: true,
  imageUrl: true,
});
export type SearchDestination = z.infer<typeof searchDestinationSchema>;

export const searchInventoryPlacementSchema = z.object({
  id: inventoryShortcode,
  locationId: locationShortcode,
  locationPath: z.string(),
  amount,
  placement: z.enum(inventoryPlacementValues),
});
export type SearchInventoryPlacement = z.infer<
  typeof searchInventoryPlacementSchema
>;

export const searchComponentPlacementSchema = z.object({
  component: searchDestinationSchema,
  componentQuantity: z.number().int().positive(),
  placement: searchInventoryPlacementSchema,
});
export type SearchComponentPlacement = z.infer<
  typeof searchComponentPlacementSchema
>;

const searchEntityGroupSchema = z.object({
  kind: z.literal("entity"),
  key: z.string(),
  primary: searchHitSchema,
  linkedProduct: searchDestinationSchema.nullable(),
});

const searchProductGroupSchema = z.object({
  kind: z.literal("product"),
  key: z.string(),
  primary: searchDestinationSchema,
  bestMatch: searchHitSchema,
  placements: z.array(searchInventoryPlacementSchema),
  componentPlacements: z.array(searchComponentPlacementSchema),
  matchedActivity: z.array(searchHitSchema),
});

/**
 * UI-only relational search projection. Flat SearchHit remains the canonical
 * MCP, picker, and entity-kernel contract.
 */
export const searchResultGroupSchema = z.discriminatedUnion("kind", [
  searchEntityGroupSchema,
  searchProductGroupSchema,
]);
export type SearchResultGroup = z.infer<typeof searchResultGroupSchema>;

export const searchResultGroupsOut = z.array(searchResultGroupSchema);

export const relatedSearchGroupsOutSchema = z.object({
  status: z.enum(["ready", "unavailable"]),
  groups: searchResultGroupsOut,
});
export type RelatedSearchGroupsOut = z.infer<
  typeof relatedSearchGroupsOutSchema
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
