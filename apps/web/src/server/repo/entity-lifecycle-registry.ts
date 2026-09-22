import type { Entity } from "@cubby/schemas/entity";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import { entityManifest } from "@cubby/schemas/entity-manifest";

import { ENTITY_KERNEL_BINDINGS } from "~/server/generated/entity-kernel-bindings.gen";
import { generatedEntityKernelEntities } from "~/server/generated/entity-kernel-entities.gen";
import { COOKBOOK_DELETE_EDGE_POLICY } from "~/server/repo/cookbook";

export interface EntityLifecycleRegistryEntry {
  entity: Entity;
  operation: "delete" | "merge";
  policy: Record<string, OperationDisposition>;
}

/**
 * Runtime lifecycle policies come from the compiled kernel bindings. The only
 * workflow-owned lifecycle operation is declared alongside its specialized
 * repository policy; entity literals remain authoritative for operation owner.
 */
export const ENTITY_LIFECYCLE_REGISTRY: EntityLifecycleRegistryEntry[] = [
  ...generatedEntityKernelEntities.flatMap((entity) => {
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
  }),
  {
    entity: "cookbook",
    operation: "delete",
    policy: COOKBOOK_DELETE_EDGE_POLICY,
  },
];
