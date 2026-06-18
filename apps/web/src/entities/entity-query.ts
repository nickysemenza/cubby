import type { Entity } from "@cubby/schemas/entity";
import { skipToken } from "@tanstack/react-query";
import { match } from "ts-pattern";
import type { useTRPC } from "~/trpc/react";

type Api = ReturnType<typeof useTRPC>;

/**
 * USDA-food route ids are the stringified `fdc_id`. These own that string↔number
 * boundary so it isn't re-spelled as `Number(id)` / `parseInt(id, 10)` /
 * `String(fdc_id)` at every call site.
 */
export const fdcIdFromParam = (id: string): number => Number.parseInt(id, 10);
export const usdaRouteId = (fdcId: number): string => String(fdcId);

// A skipped (idle) query for entities with no getByID (cookbook, meal). useQuery
// v5 throws on a non-object arg, so a caller that may pass a non-fetchable entity
// still hands useQuery a valid options object.
const skippedQuery = { queryKey: ["entity-skip"] as const, queryFn: skipToken };

/**
 * Map an entity + route id to its tRPC `getByID` queryOptions — the single
 * source for "how do I fetch entity X by id", owning the usda-food id coercion
 * and the image `getImageById` special case. Non-fetchable entities (cookbook,
 * meal) return a skipped query. The result is a union of queryOptions that
 * useQuery can't narrow, so call sites pass it through `useQuery(opts as ...)`.
 */
export function entityQueryOptions(api: Api, entity: Entity, id: string) {
  return match(entity)
    .with("product", () => api.product.getByID.queryOptions({ id }))
    .with("recipe", () => api.recipe.getByID.queryOptions({ id }))
    .with("ingredient", () => api.ingredient.getByID.queryOptions({ id }))
    .with("location", () => api.location.getByID.queryOptions({ id }))
    .with("inventory", () => api.inventory.getByID.queryOptions({ id }))
    .with("usda-food", () =>
      api.usda.getByID.queryOptions({ id: fdcIdFromParam(id) }),
    )
    .with("image", () => api.image.getImageById.queryOptions({ id }))
    .with("cookbook", "meal", () => skippedQuery)
    .exhaustive();
}
