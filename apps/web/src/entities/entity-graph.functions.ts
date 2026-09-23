import { allEntities } from "@cubby/schemas/entity-manifest";

import { entityGraphContract } from "~/contracts/entity-graph.contract";
import { defineOperationDomain } from "~/integrations/tanstack-query/operation-catalog";

/** Read-only, bounded graph expansion for entity relationship exploration. */
export const entityGraph = defineOperationDomain(entityGraphContract, {
  explore: {
    tags: [["relatedData"], ...allEntities.map((entity) => [entity] as const)],
  },
  graph: {
    // Every manifest path can cross entity kinds; relationship mutations
    // already invalidate this shared relationship surface.
    tags: [["relatedData"], ...allEntities.map((entity) => [entity] as const)],
  },
  graphPaths: {
    tags: [["relatedData"], ...allEntities.map((entity) => [entity] as const)],
  },
  connections: {
    tags: [["relatedData"], ...allEntities.map((entity) => [entity] as const)],
  },
});
