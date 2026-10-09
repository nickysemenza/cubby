import type { Entity } from "@cubby/schemas/entity";
import type { QueryClient } from "@tanstack/react-query";

import { entityDetailFor } from "~/entity/entity-detail";
import { usdaFood } from "~/integrations/tanstack-query/generated/usda.gen";
import type { CubbyOperationMeta } from "~/integrations/tanstack-query/operation-meta";

import {
  type DetailEntity,
  detailEntities,
} from "./generated/entity-details.gen";

const isDetailEntity = (entity: Entity): entity is DetailEntity =>
  detailEntities.some((candidate) => candidate === entity);

export const fdcIdFromParam = (id: string): number => Number.parseInt(id, 10);
export const usdaRouteId = (fdcId: number): string => String(fdcId);

/**
 * Map an entity + route id to its detail query options — the single source for
 * "how do I fetch entity X by id": the kernel detail read for every kernel
 * entity, and USDA's external catalog by its numeric route id.
 */
export function entityPreviewQueryOptions(entity: Entity, id: string) {
  if (entity === "usda-food") {
    return usdaFood.detail.queryOptions({ id: fdcIdFromParam(id) });
  }
  if (isDetailEntity(entity)) return entityDetailFor(entity).queryOptions(id);
  throw new Error(`Entity ${entity} has no browser detail transport`);
}

const speculativeQueryOptions = <
  TOptions extends { meta?: CubbyOperationMeta },
>(
  options: TOptions,
) => ({
  ...options,
  meta: { ...options.meta, speculative: true },
});

/** Prefetch one browser detail through its correlated descriptor. */
export function prefetchEntityPreview(
  queryClient: QueryClient,
  entity: Entity,
  id: string,
): Promise<void> {
  if (entity === "usda-food") {
    return queryClient.prefetchQuery(
      speculativeQueryOptions(
        usdaFood.detail.queryOptions({ id: fdcIdFromParam(id) }),
      ),
    );
  }
  if (isDetailEntity(entity)) {
    return queryClient.prefetchQuery(
      speculativeQueryOptions(entityDetailFor(entity).queryOptions(id)),
    );
  }
  throw new Error(`Entity ${entity} has no browser detail transport`);
}
