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

import { defineContract, query } from "~/contracts/define";

export const entityGraphContract = defineContract("entity", {
  connectedRecords: query({
    native: "Complete connection tables with record path evidence",
    input: connectedRecordsInputSchema,
    output: connectedRecordsOutputSchema,
  }),
  explore: query({
    native: "Native relationship explorer",
    input: entityGraphExploreInputSchema,
    output: entityGraphExploreOutputSchema,
  }),
  graph: query({
    native: "Native relationship branch paging",
    input: entityGraphInputSchema,
    output: entityGraphOutputSchema,
  }),
  graphPaths: query({
    native: "Native relationship path evidence",
    input: entityGraphPathsInputSchema,
    output: entityGraphPathsOutputSchema,
  }),
  connections: query({
    mcp: {
      name: "get_entity_connections",
      description:
        'One-hop physical connections of any entity: what points at it (`incoming`) and what it points at (`outgoing`), grouped by edge with a count and the first linked records. A merged-away code reads its survivor and reports `redirectedFrom`. Pass `operation: "delete"` or `"merge"` to see each incoming group\'s declared disposition (block, detach, repoint, ...) before running it; the preview is advisory and the mutation re-validates.',
      readPolicy: "strong",
    },
    native: "Native one-hop physical connections and delete/merge impact",
    input: entityConnectionsInput,
    output: entityConnectionsOut,
  }),
});
