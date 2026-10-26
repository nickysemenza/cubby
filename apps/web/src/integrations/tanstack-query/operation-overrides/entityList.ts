import type { entityListContract } from "~/contracts/entity-list.contract";
import {
  getEntityListOutputSchema,
  type ListEntity,
} from "~/entity/generated/entity-lists.gen";

import type { OperationPolicies } from "../operation-catalog";
const stableIndexEntities = new Set<ListEntity>([
  "product",
  "location",
  "recipe",
  "ingredient",
]);

export const entityListOverrides = {
  list: {
    parse: (result, input) =>
      getEntityListOutputSchema(input.entity).parse(result),
    cache: (input) =>
      stableIndexEntities.has(input.entity) ? "browse" : undefined,
  },
} satisfies OperationPolicies<(typeof entityListContract)["ops"]>;
