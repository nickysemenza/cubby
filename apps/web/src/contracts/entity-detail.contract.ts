import { z } from "zod";

import { defineContract, query } from "~/contracts/define";
import { kernelDetailWire } from "~/contracts/entity-kernel-wire";
import {
  detailEntities,
  type DetailEntity,
  type EntityDetailByEntity,
  type EntityDetailInputByEntity,
} from "~/entity/generated/entity-details.gen";

export const entityDetailContract = defineContract("entity", {
  detail: query({
    mcp: {
      omit: "kernel_alternative",
      kernel: ["get"],
      note: "The browser detail read; agents use entity_read.get",
    },
    // Type-only carriers: the per-entity runtime schemas live in the generated
    // detail bindings and are applied by the browser `parse` policy and the
    // server handler; HTTP carries the loose kernel wire.
    input: z.custom<EntityDetailInputByEntity[DetailEntity]>(),
    output: z.custom<EntityDetailByEntity[DetailEntity] | null>(),
    httpWire: kernelDetailWire,
    native: "Native record detail reads",
    observability: {
      entities: detailEntities,
      productPhases: [
        "resolve",
        "base",
        "pricing",
        "quantity",
        "breadcrumbs",
        "quality",
        "recipe_usages",
        "food",
      ],
    },
  }),
});
