import type { Entity } from "@cubby/schemas/entity";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import { entityManifest } from "@cubby/schemas/entity-manifest";

import { ENTITY_KERNEL_BINDINGS } from "~/server/generated/entity-kernel-bindings.gen";
import { generatedEntityKernelEntities } from "~/server/generated/entity-kernel-entities.gen";

export interface EntityLifecycleRegistryEntry {
  entity: Entity;
  operation: "delete" | "merge";
  policy: Record<string, OperationDisposition>;
}

/**
 * Runtime lifecycle policies come from the compiled kernel bindings; a
 * read-only entity's repository still declares the policy its own workflow
 * deletes under (cookbook). Entity literals remain authoritative for the
 * operation owner.
 */
export const ENTITY_LIFECYCLE_REGISTRY: EntityLifecycleRegistryEntry[] =
  generatedEntityKernelEntities.flatMap((entity) => {
    const lifecycle = ENTITY_KERNEL_BINDINGS[entity].lifecycle;
    return [
      // An immutable entity (`capabilities.delete: null`) binds an adapter
      // with no delete policy; it claims no lifecycle operation here.
      ...(entityManifest[entity].lifecycle.delete !== null
        ? [{ entity, operation: "delete" as const, policy: lifecycle.delete }]
        : []),
      ...(lifecycle.merge
        ? [
            {
              entity,
              operation: "merge" as const,
              policy: lifecycle.merge,
            },
          ]
        : []),
    ];
  });
