import { z } from "zod";

import { defineContract, mutation } from "~/contracts/define";
import { kernelRecordWire } from "~/contracts/entity-kernel-wire";
import { entityMutationOutputEntities } from "~/entity/generated/entity-mutation-results.gen";
import type {
  EntityBrowserMutationInput,
  EntityBrowserMutationResult,
} from "~/server/entity-kernel/contracts";

export const entityMutationContract = defineContract(
  "entity",
  {
    mutate: mutation({
      note: "The browser write path; agents use the entity tool's create, update, delete, and commands actions",
      // Report rows offer a one-tap record update (a briefing task's Done) through it.
      command: {
        label: "Update record",
        confirmation: null,
        success: "Updated",
      },
      input: z.custom<EntityBrowserMutationInput>(),
      output: z.custom<EntityBrowserMutationResult>(),
      nativeModels: { input: "json", output: "json" },
      operationWire: kernelRecordWire,
      observability: {
        entities: [
          ...entityMutationOutputEntities,
          "ledgerParty",
          "ledgerTransfer",
          "image",
        ],
      },
    }),
  },
  { exposure: "view" },
);
