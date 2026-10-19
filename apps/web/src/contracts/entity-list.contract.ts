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

export const entityListContract = defineContract("entity", {
  listBase: query({
    mcp: {
      omit: "kernel_alternative",
      kernel: ["list"],
      note: "The progressive list split for native; agents use entity_read.list",
    },
    input: entityListInputSchema,
    output: entityListBaseOutputSchema,
    native: "Progressive standard entity lists",
    observability: { entities: listEntities },
  }),
  listEnrichment: query({
    mcp: {
      omit: "kernel_alternative",
      kernel: ["list"],
      note: "The progressive list split for native; agents use entity_read.list",
    },
    input: entityListEnrichmentInputSchema,
    output: entityListEnrichmentOutputSchema,
    transport: "post",
    native: "Deferred list fields",
    observability: { entities: listEntities },
  }),
  listSummary: query({
    mcp: {
      omit: "kernel_alternative",
      kernel: ["list"],
      note: "Full-filter totals; entity_read.list returns its total",
    },
    input: entityListInputSchema,
    output: entityListSummaryOutputSchema,
    native: "Full-filter list totals",
    observability: { entities: listEntities },
  }),
  facetCounts: query({
    mcp: { omit: "client_view" },
    input: entityFacetCountsInputSchema,
    output: entityFacetCountsOutputSchema,
    observability: { entities: listEntities },
  }),
  viewCounts: query({
    mcp: { omit: "client_view" },
    input: entityViewCountsInputSchema,
    output: entityViewCountsOutputSchema,
    observability: { entities: listEntities },
  }),
  list: query({
    mcp: {
      omit: "kernel_alternative",
      kernel: ["list"],
      note: "The browser list read; agents use entity_read.list",
    },
    // Type-only carriers: the per-entity runtime schemas live in the generated
    // list bindings and are applied by the browser `parse` policy and the
    // server handler; HTTP carries the loose kernel wire.
    input: z.custom<EntityListInputByEntity[ListEntity]>(),
    output: z.custom<EntityListResultByEntity[ListEntity]>(),
    httpWire: kernelRecordWire,
    native: "Full-row entity lists (pickers, Spotlight, sheets)",
    observability: { entities: listEntities },
  }),
});
