import type { entityListContract } from "~/contracts/entity-list.contract";
import { loadEntityListSchemas } from "~/entity/model/read-schemas/loaders";

import { entityReadCacheProfile } from "../cache-tags";
import type { OperationPolicies } from "../operation-catalog";

export const entityListOverrides = {
  list: {
    cache: (input) => entityReadCacheProfile(input.entity)?.list,
    // The wire is JSON; the entity's own read schema restores its Dates.
    parse: async (value, input) => {
      const schemas = await loadEntityListSchemas(input.entity);
      return "fields" in input && input.fields !== undefined
        ? schemas.selectedListOutput.parse(value)
        : schemas.listOutput.parse(value);
    },
  },
} satisfies OperationPolicies<(typeof entityListContract)["ops"]>;
