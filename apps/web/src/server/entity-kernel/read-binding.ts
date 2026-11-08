import type { z } from "zod";

import type { EntityBindingSchemas, EntityKernelReadBinding } from "./adapter";
import type { EntityKernelEntity } from "./contracts";

type EntityReadSchemas = EntityBindingSchemas & {
  id: z.ZodType<string>;
  filters: z.ZodObject;
  detail: z.ZodObject;
};
/** Load one canonical repository without admitting its write methods to read callers. */
export async function loadEntityReadBinding(
  entity: EntityKernelEntity,
): Promise<EntityKernelReadBinding<EntityKernelEntity, EntityReadSchemas>> {
  const bindings =
    await import("~/server/generated/entity-kernel-bindings.gen");
  return bindings.repositoryReadBinding(entity).load();
}
