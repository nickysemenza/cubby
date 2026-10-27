import type { Entity } from "@cubby/schemas/entity";

import { ENTITY_KERNEL_BINDINGS } from "~/server/generated/entity-kernel-bindings.gen";
import type { EntityListScaffold } from "~/server/generic/list/repo/list";

/**
 * An entity's list scaffold, read from its repository port. Generic modules
 * receive this function (or a scaffold) from their caller instead of
 * importing a domain or keeping a roster.
 */
export const kernelScaffold = (
  entity: Entity,
): EntityListScaffold | undefined =>
  Object.entries(ENTITY_KERNEL_BINDINGS).find(([key]) => key === entity)?.[1]
    .repository.scaffold;
