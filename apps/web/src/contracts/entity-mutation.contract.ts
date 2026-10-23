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
      input: z.custom<EntityBrowserMutationInput>(),
      output: z.custom<EntityBrowserMutationResult>(),
      nativeModels: { input: "json", output: "json" },
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
  },
  { exposure: "view" },
);
