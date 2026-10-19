import { z } from "zod";

import { listEntities } from "~/entity/generated/entity-lists.gen";

/**
 * One declared filter's facet under every OTHER filter: per-value counts for
 * a stored enum, boolean, presence or reference filter (`value` is the
 * filter value a pick would send: an enum value, `true`/`false`,
 * `has`/`none`, a shortcode, or the No value key), or a range's lowest and
 * highest stored value.
 */
export const listFacetSchema = z.discriminatedUnion("kind", [
  z.object({
    id: z.string(),
    kind: z.literal("values"),
    options: z.array(
      z.object({ value: z.string(), count: z.number().int().nonnegative() }),
    ),
  }),
  z.object({
    id: z.string(),
    kind: z.literal("range"),
    min: z.string().nullable(),
    max: z.string().nullable(),
  }),
]);
export type ListFacet = z.infer<typeof listFacetSchema>;

export const entityFacetCountsInputSchema = z.object({
  entity: z.enum(listEntities),
  filters: z.record(z.string(), z.unknown()),
  /** Declared filter ids (`columnId`); unsupported ones are omitted. */
  facetIds: z.array(z.string().min(1)).min(1).max(12),
});

export const entityFacetCountsOutputSchema = z.object({
  entity: z.enum(listEntities),
  facets: z.array(listFacetSchema),
});

export const entityViewCountsInputSchema = z.object({
  entity: z.enum(listEntities),
  /** Declared saved-view ids; unknown ones are omitted. */
  viewIds: z.array(z.string().min(1)).max(24),
});

export const entityViewCountsOutputSchema = z.object({
  entity: z.enum(listEntities),
  /** The list with no filter applied: the "All" tab. */
  total: z.number().int().nonnegative(),
  views: z.array(
    z.object({ id: z.string(), count: z.number().int().nonnegative() }),
  ),
});
