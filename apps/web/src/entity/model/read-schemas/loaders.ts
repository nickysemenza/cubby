import type { readDefinitions } from "~/entity/generated/entity-read-data.gen";
import type { DetailEntity } from "~/entity/model/detail-contracts";
import type { ListEntity } from "~/entity/model/list-contracts";

import { defineEntityReadContracts } from "./define";

type Definitions = typeof readDefinitions;
type Entity = keyof Definitions;
type DataModule = { definition: Definitions[Entity] };
const modules = import.meta.glob<DataModule>(
  "../../generated/entity-read-data.*.gen.ts",
);
const cache = new Map<
  Entity,
  Promise<ReturnType<typeof defineEntityReadContracts>>
>();
type ContractsByEntity = {
  [E in Entity]: ReturnType<typeof defineEntityReadContracts<Definitions[E]>>;
};
function load<E extends Entity>(entity: E): Promise<ContractsByEntity[E]> {
  let pending = cache.get(entity);
  if (!pending) {
    const loader = modules[`../../generated/entity-read-data.${entity}.gen.ts`];
    if (!loader) throw new Error(`No entity schema module for ${entity}`);
    pending = loader().then(({ definition }) =>
      defineEntityReadContracts(definition),
    );
    cache.set(entity, pending);
  }
  // SAFETY: a cached entry is constructed from the generated definition module
  // selected by this exact entity key.
  return pending as Promise<ContractsByEntity[E]>;
}
export function loadEntityListSchemas(entity: ListEntity) {
  return load(entity);
}
export function loadEntityDetailSchemas(entity: DetailEntity) {
  return load(entity);
}
