import { z } from "zod";

import { defineContract, mutation } from "~/contracts/define";
import { kernelRecordWire } from "~/contracts/entity-kernel-wire";
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
    // kernel and are applied by the server handler; HTTP carries the loose
    // kernel wire.
    input: z.custom<EntityBrowserMutationInput>(),
    output: z.custom<EntityBrowserMutationResult>(),
    httpWire: kernelRecordWire,
    native: "Native create, update, delete and image attach/order",
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
