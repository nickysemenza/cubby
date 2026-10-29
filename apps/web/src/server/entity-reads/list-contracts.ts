import type { z } from "zod";
import { z as schema } from "zod";

import { readDefinitions } from "~/entity/generated/entity-read-data.gen";
import { listEntities } from "~/entity/generated/entity-read-keys.gen";
import { defineEntityReadContracts } from "~/entity/model/read-schemas/define";

export { listEntities };
export type ListEntity = (typeof listEntities)[number];
type ContractsByEntity = {
  [E in ListEntity]: ReturnType<
    typeof defineEntityReadContracts<(typeof readDefinitions)[E]>
  >;
};
// SAFETY: the generated tuple and definition table share the declaration roster;
// each key is paired with the factory instantiated on precisely that definition.
const contracts = Object.fromEntries(
  listEntities.map((entity) => [
    entity,
    defineEntityReadContracts(readDefinitions[entity]),
  ]),
) as ContractsByEntity;
// SAFETY: projection preserves the correlated key and schema from contracts.
export const ENTITY_LIST_READ_SCHEMAS = Object.fromEntries(
  listEntities.map((entity) => [entity, contracts[entity].listRead]),
) as { [E in ListEntity]: ContractsByEntity[E]["listRead"] };
export type EntityListResultByEntity = {
  [E in ListEntity]: z.output<ContractsByEntity[E]["listOutput"]>;
};
export const entityListInputSchema = schema.discriminatedUnion("entity", [
  contracts[listEntities[0]].listInput,
  ...listEntities.slice(1).map((entity) => contracts[entity].listInput),
]);

export function getEntityListOutputSchema<E extends ListEntity>(
  entity: E,
): ContractsByEntity[E]["listOutput"] {
  return contracts[entity].listOutput;
}

export function getEntityListItemSchema<E extends ListEntity>(
  entity: E,
): ContractsByEntity[E]["listItem"] {
  return contracts[entity].listItem;
}
