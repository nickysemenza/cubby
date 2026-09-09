import {
  entityGraphInputSchema,
  entityGraphOutputSchema,
  entityGraphPathsInputSchema,
  entityGraphPathsOutputSchema,
} from "@cubby/schemas/entity-graph";
import { allEntities } from "@cubby/schemas/entity-manifest";

import {
  defineOperationDomain,
  query,
} from "~/integrations/tanstack-query/operation-catalog";

/** Read-only, bounded graph expansion for entity relationship exploration. */
export const entityGraph = defineOperationDomain("entity", {
  graph: query({
    input: entityGraphInputSchema,
    output: entityGraphOutputSchema,
    // Every manifest path can cross entity kinds; relationship mutations
    // already invalidate this shared relationship surface.
    tags: [["relatedData"], ...allEntities.map((entity) => [entity] as const)],
  }),
  graphPaths: query({
    input: entityGraphPathsInputSchema,
    output: entityGraphPathsOutputSchema,
    tags: [["relatedData"], ...allEntities.map((entity) => [entity] as const)],
  }),
});
