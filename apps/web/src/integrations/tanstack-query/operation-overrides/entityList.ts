import type { entityListContract } from "~/contracts/entity-list.contract";
import { type ListEntity } from "~/entity/generated/entity-lists.gen";

import type { OperationPolicies } from "../operation-catalog";
const stableIndexEntities = new Set<ListEntity>([
  "product",
  "location",
  "recipe",
  "ingredient",
]);

export const entityListOverrides = {
  list: {
    cache: (input) =>
      stableIndexEntities.has(input.entity) ? "browse" : undefined,
  },
} satisfies OperationPolicies<(typeof entityListContract)["ops"]>;
