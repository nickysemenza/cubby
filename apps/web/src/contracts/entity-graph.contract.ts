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
});
