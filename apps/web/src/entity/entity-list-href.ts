import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";

import { entities } from "~/entity/entities";
import { getEntityFilters } from "~/entity/filter-manifest";
import { encodeFilters, sortToParam } from "~/entity/filters";
import type { ViewDefinition } from "~/entity/model/view-manifest";

type ListState = {
  filters: readonly ViewDefinition["filters"][number][];
  sort?: readonly { id: string; desc: boolean }[];
  view?: string;
  groupBy?: string;
};

/**
 * The list route search that reproduces declared filter, sort, view, and
 * grouping state exactly: the same column-filter encoding the list writes
 * itself. An undeclared filter id throws rather than yielding a silently wider
 * list.
 */
export const entityListSearch = (
  entity: BrowserRoutedEntity,
  state: ListState,
) => {
  const specs = getEntityFilters(entity);
  const known = new Set(specs.map((spec) => spec.columnId));
  const unknown = state.filters.find(({ id }) => !known.has(id));
  if (unknown)
    throw new Error(`${entity} list has no filter ${unknown.id} to link`);
  const values = new Map(state.filters.map(({ id, value }) => [id, value]));
  const search: Record<string, string> = {};
  for (const [key, value] of Object.entries(
    encodeFilters(specs, (columnId) => values.get(columnId)),
  )) {
    if (value !== undefined) search[key] = value;
  }
  const sort = state.sort && sortToParam([...state.sort]);
  if (sort) search.sort = sort;
  if (state.view) search.view = state.view;
  if (state.groupBy) search.groupBy = state.groupBy;
  return search;
};

/** `href` (not a typed `to`) because the entity is dynamic. */
export const entityListHref = (
  entity: BrowserRoutedEntity,
  state: ListState,
  params: Record<string, string> = {},
): string =>
  `${entities[entity].routes.list}?${new URLSearchParams({
    ...params,
    ...entityListSearch(entity, state),
  }).toString()}`;
