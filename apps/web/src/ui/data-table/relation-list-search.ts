import type {
  RelationFilter,
  RelationFilterSpec,
  RelationListUrlKey,
} from "@cubby/schemas/relation-list";
import { z } from "zod";

import { urlStringParam } from "~/lib/search-params";
import { tableSearchFields } from "~/ui/data-table/table-search";

/** Every URL key one declared filter writes. */
const specUrlKeys = (spec: RelationFilterSpec): string[] => [
  ...(spec.range ? [spec.range.from, spec.range.to] : [spec.columnId]),
  ...(spec.exclude ? [spec.exclude.field] : []),
  ...(spec.nullable ? [spec.nullable.field] : []),
];

/**
 * A relation list's route search: its declared filters' keys plus search,
 * saved view and Group by. Values stay strings; the list's input schema
 * parses them when the read is built.
 */
export const relationListSearch = <
  L extends {
    readonly filters: readonly RelationFilter[];
    readonly specs: readonly RelationFilterSpec[];
  },
>(
  list: L,
) =>
  z.object({
    ...tableSearchFields,
    query: urlStringParam,
    view: urlStringParam,
    group: urlStringParam,
    // SAFETY: the keys are exactly the specs' URL keys, each a string param.
    ...(Object.fromEntries(
      list.specs
        .flatMap(specUrlKeys)
        .map((key) => [key, urlStringParam] as const),
    ) as Record<RelationListUrlKey<L>, typeof urlStringParam>),
  });
