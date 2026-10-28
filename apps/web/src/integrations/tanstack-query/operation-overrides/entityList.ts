import type { entityListContract } from "~/contracts/entity-list.contract";
import { type ListEntity } from "~/entity/generated/entity-lists.gen";
import { loadEntityListSchemas } from "~/entity/model/read-schemas/loaders";

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
    // The wire is JSON; the entity's own read schema restores its Dates.
    parse: async (value, input) => {
      const schemas = await loadEntityListSchemas(input.entity);
      return "fields" in input && input.fields !== undefined
        ? schemas.selectedListOutput.parse(value)
        : schemas.listOutput.parse(value);
    },
  },
} satisfies OperationPolicies<(typeof entityListContract)["ops"]>;
