import { connectionDiscoveryOut } from "@cubby/schemas/entity-connections";
import { entityGraphRootSchema } from "@cubby/schemas/entity-graph";
import { allEntities } from "@cubby/schemas/entity-manifest";
import { z } from "zod";

import { defineContract, mutation, query } from "~/contracts/define";

export const connectionContract = defineContract("connection", {
  read: query({
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
