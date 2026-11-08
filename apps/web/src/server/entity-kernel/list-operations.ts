import type { z } from "zod";

import type { ListEntity } from "~/entity/model/list-contracts";

import type { EntityBindingSchemas, EntityKernelCoreBinding } from "./adapter";
import type { EntityKernelEntity } from "./contracts";
import { defineListOperations } from "./list-read";

type EntityReadSchemas = EntityBindingSchemas & {
  id: z.ZodType<string>;
  filters: z.ZodObject;
};
type CoreReadBinding = EntityKernelCoreBinding<
  EntityKernelEntity,
  EntityReadSchemas
>;
type EntityReadBinding = Pick<
  CoreReadBinding,
  "entity" | "schemas" | "sort"
> & {
  repository: Pick<CoreReadBinding["repository"], "scaffold" | "listRead">;
};

/** Load one canonical repository without admitting its write methods to read callers. */
export async function loadEntityReadBinding(
  entity: EntityKernelEntity,
): Promise<EntityReadBinding> {
  const bindings =
    await import("~/server/generated/entity-kernel-bindings.gen");
  return bindings.repositoryReadBinding(entity).load();
}

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
