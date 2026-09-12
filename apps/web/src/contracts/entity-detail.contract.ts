import { z } from "zod";

import { defineContract, query } from "~/contracts/define";
import {
  detailEntities,
  type DetailEntity,
  type EntityDetailByEntity,
  type EntityDetailInputByEntity,
} from "~/entities/generated/entity-details.gen";

export const entityDetailContract = defineContract("entity", {
  detail: query({
    // Type-only carriers: the per-entity runtime schemas live in the generated
    // detail bindings and are applied by the browser `parse` policy and the
    // server handler; the HTTP router substitutes the real wire schema.
    input: z.custom<EntityDetailInputByEntity[DetailEntity]>(),
    output: z.custom<EntityDetailByEntity[DetailEntity] | null>(),
    // HTTP serves these as the per-entity resource routes instead.
    http: false,
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
