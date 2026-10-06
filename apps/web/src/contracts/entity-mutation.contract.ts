import { z } from "zod";

import { defineContract, mutation } from "~/contracts/define";
import { entityMutationOutputEntities } from "~/entity/generated/entity-mutation-results.gen";
import type {
  EntityBrowserMutationInput,
  EntityBrowserMutationResult,
} from "~/server/entity-kernel/contracts";

export const entityMutationContract = defineContract("entity", {
  mutate: mutation({
    mcp: {
      omit: "kernel_alternative",
      kernel: ["create", "update", "delete", "commands"],
      note: "The browser write path; agents use the entity tool's create, update, delete, and commands actions",
    },
    // Type-only carriers: the per-entity runtime schemas live in the entity
    // kernel and are applied by the server handler; the HTTP router
    // substitutes the real wire schema.
    input: z.custom<EntityBrowserMutationInput>(),
    output: z.custom<EntityBrowserMutationResult>(),
    // HTTP serves these as the per-entity resource routes instead.
    http: false,
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
