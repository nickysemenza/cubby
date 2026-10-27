import type { ListEntity } from "~/entity/generated/entity-lists.gen";
import { ENTITY_KERNEL_BINDINGS } from "~/server/generated/entity-kernel-bindings.gen";

import type { EntityBindingSchemas, EntityKernelCoreBinding } from "./adapter";
import { defineListOperations } from "./list-read";

type ListOperations = ReturnType<
  typeof defineListOperations<ListEntity, EntityBindingSchemas>
>;
const operations = new Map<ListEntity, ListOperations>();

/** The generic list operations (selected fields, facets, view counts) of a list entity. */
export const listOperations = (entity: ListEntity): ListOperations => {
  let built = operations.get(entity);
  if (!built) {
    const binding: EntityKernelCoreBinding<ListEntity, EntityBindingSchemas> =
      ENTITY_KERNEL_BINDINGS[entity];
    built = defineListOperations(binding);
    operations.set(entity, built);
  }
  return built;
};
