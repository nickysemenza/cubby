import type { entityDetailContract } from "~/contracts/entity-detail.contract";
import { type DetailEntity } from "~/entity/generated/entity-details.gen";
import { loadEntityDetailSchemas } from "~/entity/model/read-schemas/loaders";

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
    cache: (input) =>
      persistedDetailEntities.has(input.entity)
        ? "persisted-detail"
        : undefined,
    // The wire is JSON; the entity's own read schema restores its Dates.
    parse: async (value, input) =>
      value === null
        ? null
        : (await loadEntityDetailSchemas(input.entity)).detailOutput.parse(
            value,
          ),
  },
} satisfies OperationPolicies<(typeof entityDetailContract)["ops"]>;
