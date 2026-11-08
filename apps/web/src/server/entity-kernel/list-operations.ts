import type { ListEntity } from "~/entity/model/list-contracts";

import type { EntityBindingSchemas } from "./adapter";
import { defineListOperations } from "./list-read";
import { loadEntityReadBinding } from "./read-binding";

type ListOperations = ReturnType<
  typeof defineListOperations<ListEntity, EntityBindingSchemas>
>;
const operations = new Map<ListEntity, Promise<ListOperations>>();

/** The generic list operations (selected fields, facets, view counts) of a list entity. */
export const listOperations = (entity: ListEntity): Promise<ListOperations> => {
  let built = operations.get(entity);
  if (!built) {
    built = loadEntityReadBinding(entity).then(defineListOperations);
    operations.set(entity, built);
  }
  return built;
};
