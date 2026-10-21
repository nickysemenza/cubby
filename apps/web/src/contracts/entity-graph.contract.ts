import {
  connectedRecordsInputSchema,
  connectedRecordsOutputSchema,
  connectedRecordsPreviewInputSchema,
  connectedRecordsPreviewOutputSchema,
} from "@cubby/schemas/connected-records";
import {
  connectionDiscoveryOut,
  entityConnectionsInput,
  entityConnectionsOut,
} from "@cubby/schemas/entity-connections";
import {
  monthlyExpenseSpendInputSchema,
  monthlyExpenseSpendOutputSchema,
  detailActivityInputSchema,
  detailActivityOutputSchema,
} from "@cubby/schemas/entity-detail-data";
import {
  entityGraphExploreInputSchema,
  entityGraphExploreOutputSchema,
  entityGraphInputSchema,
  entityGraphOutputSchema,
  entityGraphRootSchema,
  entityGraphPathsInputSchema,
  entityGraphPathsOutputSchema,
} from "@cubby/schemas/entity-graph";
import { allEntities } from "@cubby/schemas/entity-manifest";
import { z } from "zod";

import { ENTITY_ROOT_TAGS } from "~/contracts/cache-policy";
import { defineContract, mutation, query } from "~/contracts/define";
import {
  generatedEntityRelationListInputSchema,
  generatedEntityRelationListOutputSchema,
} from "~/entity/generated/entity-relation-lists.gen";

import {
  entityRecordsInputSchema,
  entityRecordsOutputSchema,
} from "./entity-records.schema";

export const entityGraphContract = defineContract("entity", {
  monthlyExpenseSpend: query({
    mcp: { omit: "client_view" },
    native: "Native generic detail monthly expense chart",
    input: monthlyExpenseSpendInputSchema,
    output: monthlyExpenseSpendOutputSchema,
    cache: { tags: [["relatedData"], ...ENTITY_ROOT_TAGS] },
  }),
  detailActivity: query({
    mcp: { omit: "client_view" },
    native: "Native generic detail activity timeline",
    input: detailActivityInputSchema,
    output: detailActivityOutputSchema,
    cache: { tags: [["relatedData"], ...ENTITY_ROOT_TAGS] },
  }),
  records: query({
    mcp: {
      omit: "client_view",
      note: "Agents read relations through entity_read.relations and entity_read.connections",
    },
    input: entityRecordsInputSchema,
    output: entityRecordsOutputSchema,
    cache: { tags: [["relatedData"], ...ENTITY_ROOT_TAGS] },
  }),
  connectedRecords: query({
    mcp: { omit: "client_view" },
    native: "Complete connection tables with record path evidence",
    input: connectedRecordsInputSchema,
    output: connectedRecordsOutputSchema,
    cache: { tags: [["relatedData"], ...ENTITY_ROOT_TAGS] },
  }),
  connectedRecordsPreview: query({
    mcp: { omit: "client_view" },
    native: "Detail-page connected records, first rows of every view",
    input: connectedRecordsPreviewInputSchema,
    output: connectedRecordsPreviewOutputSchema,
    cache: { tags: [["relatedData"], ...ENTITY_ROOT_TAGS] },
  }),
  explore: query({
    mcp: { omit: "client_view" },
    native: "Native relationship explorer",
    input: entityGraphExploreInputSchema,
    output: entityGraphExploreOutputSchema,
    cache: { tags: [["relatedData"], ...ENTITY_ROOT_TAGS] },
  }),
  graph: query({
    mcp: { omit: "client_view" },
    native: "Native relationship branch paging",
    input: entityGraphInputSchema,
    output: entityGraphOutputSchema,
    cache: { tags: [["relatedData"], ...ENTITY_ROOT_TAGS] },
  }),
  graphPaths: query({
    mcp: { omit: "client_view" },
    native: "Native relationship path evidence",
    input: entityGraphPathsInputSchema,
    output: entityGraphPathsOutputSchema,
    cache: { tags: [["relatedData"], ...ENTITY_ROOT_TAGS] },
  }),
  relation: query({
    native: "Paged declared relation rows with provenance and movement facts",
    input: generatedEntityRelationListInputSchema,
    output: generatedEntityRelationListOutputSchema,
    cache: { tags: [["relatedData"], ...ENTITY_ROOT_TAGS] },
  }),
  connections: query({
    native: "Native one-hop physical connections and delete/merge impact",
    input: entityConnectionsInput,
    output: entityConnectionsOut,
    cache: { tags: [["relatedData"], ...ENTITY_ROOT_TAGS] },
  }),
});

export const connectionContract = defineContract("connection", {
  read: query({
    mcp: {
      omit: "client_view",
      note: "Native legacy read; agents use the scoped suggestion_queue",
    },
    input: entityGraphRootSchema,
    output: connectionDiscoveryOut,
    cache: {
      tags: [
        ["connections"],
        ...allEntities.map((entity) => [entity] as const),
      ],
    },
    native: "Read stored connection candidates from either endpoint",
  }),
  readBatch: query({
    input: z.object({ sources: z.array(entityGraphRootSchema).max(250) }),
    output: z.array(connectionDiscoveryOut),
    cache: {
      tags: [
        ["connections"],
        ...allEntities.map((entity) => [entity] as const),
      ],
    },
    mcp: { omit: "client_view" },
  }),
  discover: mutation({
    input: entityGraphRootSchema,
    output: connectionDiscoveryOut,
    invalidates: ["connections"],
    native: "Explicitly discover connections using existing typed matchers",
  }),
});
