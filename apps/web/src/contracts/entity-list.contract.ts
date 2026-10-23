import { listNestingSchema } from "@cubby/schemas/pagination";
import { z } from "zod";

import { defineContract, query } from "~/contracts/define";
import { kernelRecordWire } from "~/contracts/entity-kernel-wire";
import {
  type EntityListInputByEntity,
  type EntityListResultByEntity,
  listEntities,
  entityListInputSchema,
  entityListBaseOutputSchema,
  entityListEnrichmentInputSchema,
  entityListEnrichmentOutputSchema,
  entityListSummaryOutputSchema,
  type ListEntity,
} from "~/entity/generated/entity-lists.gen";

/**
 * One declared filter's facet under every OTHER filter: per-value counts for
 * a stored enum, boolean, presence or reference filter (`value` is the
 * filter value a pick would send: an enum value, `true`/`false`,
 * `has`/`none`, a shortcode, or the No value key), or a range's lowest and
 * highest stored value.
 */
const listFacetSchema = z.discriminatedUnion("kind", [
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

const entityFacetCountsInputSchema = z.object({
  entity: z.enum(listEntities),
  filters: z.record(z.string(), z.unknown()),
  /** Declared filter ids (`columnId`); unsupported ones are omitted. */
  facetIds: z.array(z.string().min(1)).min(1).max(12),
});

const entityFacetCountsOutputSchema = z.object({
  entity: z.enum(listEntities),
  facets: z.array(listFacetSchema),
});

const entityViewCountsInputSchema = z.object({
  entity: z.enum(listEntities),
  /**
   * Each saved view with its filters compiled by the browser's filter
   * manifest, exactly as the list sends them once the view is applied.
   */
  views: z
    .array(
      z.object({
        id: z.string().min(1),
        filters: z.record(z.string(), z.unknown()),
      }),
    )
    .max(24),
});

const entityViewCountsOutputSchema = z.object({
  entity: z.enum(listEntities),
  /** The list with no filter applied: the "All" tab. */
  total: z.number().int().nonnegative(),
  views: z.array(
    z.object({ id: z.string(), count: z.number().int().nonnegative() }),
  ),
});

export const entitySelectionIdsInputSchema = z.object({
  entity: z.enum(listEntities),
  filters: z.record(z.string(), z.unknown()).default({}),
  nesting: listNestingSchema.optional(),
  cursor: z
    .string()
    .min(1)
    .optional()
    .describe("Opaque continuation; refuses population changes between pages"),
  limit: z.number().int().min(1).max(500).default(500),
});
export const entitySelectionIdsOutputSchema = z.object({
  ids: z.array(z.string().min(1)),
  totalCount: z.number().int().nonnegative(),
  nextCursor: z.string().min(1).nullable(),
});

export const entityListContract = defineContract(
  "entity",
  {
    selectionIds: query({
      input: entitySelectionIdsInputSchema,
      output: entitySelectionIdsOutputSchema,
      observability: { entities: listEntities },
    }),
    listBase: query({
      note: "The progressive list split for native; agents use entity_read.list",
      input: entityListInputSchema,
      output: entityListBaseOutputSchema,
      nativeModels: { input: "json", output: "json" },
      observability: { entities: listEntities },
    }),
    listEnrichment: query({
      note: "The progressive list split for native; agents use entity_read.list",
      input: entityListEnrichmentInputSchema,
      output: entityListEnrichmentOutputSchema,
      nativeModels: { input: "json", output: "json" },
      observability: { entities: listEntities },
    }),
    listSummary: query({
      note: "Full-filter totals; entity_read.list returns its total",
      input: entityListInputSchema,
      output: entityListSummaryOutputSchema,
      nativeModels: { input: "json", output: "json" },
      observability: { entities: listEntities },
    }),
    facetCounts: query({
      input: entityFacetCountsInputSchema,
      output: entityFacetCountsOutputSchema,
      observability: { entities: listEntities },
    }),
    viewCounts: query({
      input: entityViewCountsInputSchema,
      output: entityViewCountsOutputSchema,
      observability: { entities: listEntities },
    }),
    list: query({
      note: "The browser list read; agents use entity_read.list",
      input: z.custom<EntityListInputByEntity[ListEntity]>(),
      output: z.custom<EntityListResultByEntity[ListEntity]>(),
      nativeModels: { input: "json", output: "json" },
      operationWire: kernelRecordWire,
      observability: { entities: listEntities },
    }),
  },
  { exposure: "view" },
);
