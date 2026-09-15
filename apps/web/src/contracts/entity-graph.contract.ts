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
    input: entityGraphExploreInputSchema,
    output: entityGraphExploreOutputSchema,
  }),
  graph: query({
    input: entityGraphInputSchema,
    output: entityGraphOutputSchema,
  }),
  graphPaths: query({
    input: entityGraphPathsInputSchema,
    output: entityGraphPathsOutputSchema,
  }),
});
