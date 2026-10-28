import type { Entity } from "@cubby/schemas/entity";
import type { QueryClient } from "@tanstack/react-query";

import { entityMetadata } from "~/entity/metadata";

/** The requested slice owns both loader and mounted table opening sort. */
export const generatedSortRoster = (queryClient: QueryClient, entity: Entity) =>
  entityMetadata(queryClient, entity).sort;

export const defaultSortFor = (
  queryClient: QueryClient,
  entity: Entity,
): string => generatedSortRoster(queryClient, entity)?.default ?? "createdAt";

export const defaultSortDirectionFor = (
  queryClient: QueryClient,
  entity: Entity,
): "asc" | "desc" =>
  generatedSortRoster(queryClient, entity)?.direction ?? "desc";

export function entityListDefaultSort(
  queryClient: QueryClient,
  entity: Entity,
) {
  return {
    orderBy: defaultSortFor(queryClient, entity),
    direction: defaultSortDirectionFor(queryClient, entity),
  };
}
