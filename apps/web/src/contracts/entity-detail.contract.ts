import { z } from "zod";

import { defineContract, query } from "~/contracts/define";
import { kernelDetailWire } from "~/contracts/entity-kernel-wire";
import {
  detailEntities,
  type DetailEntity,
  type EntityDetailByEntity,
  type EntityDetailInputByEntity,
} from "~/entity/generated/entity-details.gen";

export const entityDetailContract = defineContract(
  "entity",
  {
    detail: query({
      note: "The browser detail read; agents use entity_read.get",
      input: z.custom<EntityDetailInputByEntity[DetailEntity]>(),
      output: z.custom<EntityDetailByEntity[DetailEntity] | null>(),
      nativeModels: { input: "json", output: "json" },
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
  },
  { exposure: "view" },
);
