import type {
  ListGroupBy,
  ListGroupMargin,
  ListGroupSummary,
} from "@cubby/schemas/pagination";
import type { ColumnFiltersState } from "@tanstack/react-table";

import type { FilterSpec } from "~/entity/filter-manifest";
import { FILTER_EXACT, FILTER_NONE } from "~/entity/filters";
import type { entityMetadata } from "~/entity/metadata";

type GroupingChoice = ReturnType<
  typeof entityMetadata
>["listFields"]["grouping"][number];

export interface GroupDrillContext {
  groupBy: readonly ListGroupBy[] | undefined;
  grouping: readonly GroupingChoice[];
  fields: readonly FilterSpec[];
  groups: readonly ListGroupSummary[];
}

/**
 * The column filters that select exactly one group path's records, or
 * undefined when a dimension cannot be filtered: a bucketed date, a choice
 * without a filter mapping, or "no value" where its filter has none. Grouped
 * sections and Pivot cells share this one eligibility rule.
 */
export function groupPathFilters(
  context: GroupDrillContext,
  path: readonly string[],
): ColumnFiltersState | undefined {
  let filters: ColumnFiltersState = [];
  for (const [depth, key] of path.entries()) {
    const dimension = context.groupBy?.[depth];
    const choice = context.grouping.find(
      (entry) => entry.key === dimension?.key,
    );
    const filter = dimension?.bucket ? null : choice?.filter;
    const spec = filter
      ? context.fields.find((entry) => entry.columnId === filter.columnId)
      : undefined;
    if (!filter || !spec || (key === FILTER_NONE && !filter.noValue))
      return undefined;
    const summary = context.groups.find(
      (entry) => entry.key === JSON.stringify(path.slice(0, depth + 1)),
    );
    // A hierarchy value matches its subtree; a section counting only the
    // value itself narrows to it exactly.
    const value =
      spec.subtree && !summary?.subtree ? [key, FILTER_EXACT] : [key];
    filters = [
      ...filters.filter(({ id }) => id !== filter.columnId),
      { id: filter.columnId, value },
    ];
  }
  return filters;
}

/** Replace each drilled column's filter, keeping the member's other filters. */
export const withGroupFilters = (
  previous: ColumnFiltersState,
  drilled: ColumnFiltersState,
): ColumnFiltersState => [
  ...previous.filter(({ id }) => !drilled.some((entry) => entry.id === id)),
  ...drilled,
];

/** The root-level section's filter field, for Hide. */
export function groupRootField(context: GroupDrillContext, key: string) {
  const dimension = context.groupBy?.[0];
  const choice = context.grouping.find((entry) => entry.key === dimension?.key);
  const filter = dimension?.bucket ? null : choice?.filter;
  const spec = filter
    ? context.fields.find((entry) => entry.columnId === filter.columnId)
    : undefined;
  return filter && spec && (key !== FILTER_NONE || filter.noValue)
    ? { filter, spec, key }
    : undefined;
}

/** A grouped list's full-population summaries, for layouts that draw no rows. */
export interface GroupSummaryModel {
  groupBy: readonly ListGroupBy[];
  groups: readonly ListGroupSummary[];
  margins: readonly ListGroupMargin[];
  /** Distinct records under the current filters. */
  totalCount: number | undefined;
  /** The filters one path selects, or undefined when it cannot drill. */
  drillFilters: (path: readonly string[]) => ColumnFiltersState | undefined;
  /** Apply those filters to the list; the caller switches the layout. */
  drill: (path: readonly string[]) => void;
}
