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
    native: "Native one-hop physical connections and delete/merge impact",
    input: entityConnectionsInput,
    output: entityConnectionsOut,
  }),
});
