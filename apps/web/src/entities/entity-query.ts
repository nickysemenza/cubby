import type { Entity } from "@cubby/schemas/entity";
import type { useTRPC } from "~/trpc/react";
import {
  fdcIdFromParam,
  getEntityContract,
  usdaRouteId,
} from "./entity-contracts";

type Api = ReturnType<typeof useTRPC>;

export { fdcIdFromParam, usdaRouteId };

/**
 * Map an entity + route id to its tRPC `getByID` queryOptions — the single
 * source for "how do I fetch entity X by id", owning the USDA route-id coercion,
 * the image `getByID` special case, and non-previewable skips. The result
 * is a union of queryOptions that useQuery can't narrow, so call sites pass it
 * through `useQuery(opts as ...)`.
 */
export function entityQueryOptions(api: Api, entity: Entity, id: string) {
  const detailQuery = getEntityContract(entity).query.detail;
  if (!detailQuery) {
    throw new Error(`Entity ${entity} has no detail query contract`);
  }
  return detailQuery(api, id);
}
