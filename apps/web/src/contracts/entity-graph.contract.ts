import {
  connectedRecordsInputSchema,
  connectedRecordsOutputSchema,
} from "@cubby/schemas/connected-records";
import {
  entityConnectionsInput,
  entityConnectionsOut,
} from "@cubby/schemas/entity-connections";
import {
  entityGraphExploreInputSchema,
  entityGraphExploreOutputSchema,
  entityGraphInputSchema,
  entityGraphOutputSchema,
  entityGraphPathsInputSchema,
  entityGraphPathsOutputSchema,
} from "@cubby/schemas/entity-graph";

import { ENTITY_ROOT_TAGS } from "~/contracts/cache-policy";
import { defineContract, query } from "~/contracts/define";
import {
  generatedEntityRelationListInputSchema,
  generatedEntityRelationListOutputSchema,
} from "~/entity/generated/entity-relation-lists.gen";

import {
  entityRecordsInputSchema,
  entityRecordsOutputSchema,
} from "./entity-records.schema";

export const entityGraphContract = defineContract("entity", {
  records: query({
    input: entityRecordsInputSchema,
    output: entityRecordsOutputSchema,
    cache: { tags: [["relatedData"], ...ENTITY_ROOT_TAGS] },
  }),
  connectedRecords: query({
    native: "Complete connection tables with record path evidence",
    input: connectedRecordsInputSchema,
    output: connectedRecordsOutputSchema,
    cache: { tags: [["relatedData"], ...ENTITY_ROOT_TAGS] },
  }),
  explore: query({
    native: "Native relationship explorer",
    input: entityGraphExploreInputSchema,
    output: entityGraphExploreOutputSchema,
    cache: { tags: [["relatedData"], ...ENTITY_ROOT_TAGS] },
  }),
  graph: query({
    native: "Native relationship branch paging",
    input: entityGraphInputSchema,
    output: entityGraphOutputSchema,
    cache: { tags: [["relatedData"], ...ENTITY_ROOT_TAGS] },
  }),
  graphPaths: query({
    native: "Native relationship path evidence",
    input: entityGraphPathsInputSchema,
    output: entityGraphPathsOutputSchema,
    cache: { tags: [["relatedData"], ...ENTITY_ROOT_TAGS] },
  }),
  relation: query({
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
