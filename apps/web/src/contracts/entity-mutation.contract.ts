import { z } from "zod";

import { defineContract, mutation } from "~/contracts/define";
import { entityMutationOutputEntities } from "~/entities/generated/entity-mutation-results.gen";
import type {
  EntityBrowserMutationInput,
  EntityBrowserMutationResult,
} from "~/server/entity-kernel/contracts";

export const entityMutationContract = defineContract("entity", {
  mutate: mutation({
    // Type-only carriers: the per-entity runtime schemas live in the entity
    // kernel and are applied by the server handler; the HTTP router
    // substitutes the real wire schema.
    input: z.custom<EntityBrowserMutationInput>(),
    output: z.custom<EntityBrowserMutationResult>(),
    observability: {
      entities: [
        ...entityMutationOutputEntities,
        "ledgerParty",
        "ledgerTransfer",
        "image",
      ],
    },
  }),
});
