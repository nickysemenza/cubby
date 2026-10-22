import type { entityDetailContract } from "~/contracts/entity-detail.contract";
import {
  getEntityDetailOutputSchema,
  type DetailEntity,
} from "~/entity/generated/entity-details.gen";

import type { OperationPolicies } from "../operation-catalog";
const persistedDetailEntities = new Set<DetailEntity>([
  "product",
  "location",
  "recipe",
  "ingredient",
  "inventory",
]);

export const entityDetailOverrides = {
  detail: {
    parse: (result, input) =>
      result === null
        ? null
        : getEntityDetailOutputSchema(input.entity).parse(result),
    cache: (input) =>
      persistedDetailEntities.has(input.entity)
        ? "persisted-detail"
        : undefined,
  },
} satisfies OperationPolicies<(typeof entityDetailContract)["ops"]>;
