import { z } from "zod";

import { defineContract, query } from "~/contracts/define";
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

export const entityListContract = defineContract("entity", {
  listBase: query({
    input: entityListInputSchema,
    output: entityListBaseOutputSchema,
    native: "Progressive standard entity lists",
    observability: { entities: listEntities },
  }),
  listEnrichment: query({
    input: entityListEnrichmentInputSchema,
    output: entityListEnrichmentOutputSchema,
    transport: "post",
    native: "Deferred list fields",
    observability: { entities: listEntities },
  }),
  listSummary: query({
    input: entityListInputSchema,
    output: entityListSummaryOutputSchema,
    native: "Full-filter list totals",
    observability: { entities: listEntities },
  }),
  list: query({
    // Type-only carriers: the per-entity runtime schemas live in the generated
    // list bindings and are applied by the browser `parse` policy and the
    // server handler; the HTTP router substitutes the real wire schema.
    input: z.custom<EntityListInputByEntity[ListEntity]>(),
    output: z.custom<EntityListResultByEntity[ListEntity]>(),
    // HTTP serves these as the per-entity resource routes instead.
    http: false,
    observability: { entities: listEntities },
  }),
});
