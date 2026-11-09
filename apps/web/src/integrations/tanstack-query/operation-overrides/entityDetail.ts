import type { entityDetailContract } from "~/contracts/entity-detail.contract";
import { loadEntityDetailSchemas } from "~/entity/model/read-schemas/loaders";

import { entityReadCacheProfile } from "../cache-tags";
import type { OperationPolicies } from "../operation-catalog";

export const entityDetailOverrides = {
  detail: {
    cache: (input) => entityReadCacheProfile(input.entity)?.detail,
    // The wire is JSON; the entity's own read schema restores its Dates.
    parse: async (value, input) =>
      value === null
        ? null
        : (await loadEntityDetailSchemas(input.entity)).detailOutput.parse(
            value,
          ),
  },
} satisfies OperationPolicies<(typeof entityDetailContract)["ops"]>;
