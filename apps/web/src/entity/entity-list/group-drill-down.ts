import type {
  ListGroupBy,
  ListGroupMargin,
  ListGroupMetric,
  ListGroupSummary,
} from "@cubby/schemas/pagination";
import type { ColumnFiltersState } from "@tanstack/react-table";

import type { FilterSpec } from "~/entity/filter-manifest";
import { FILTER_NONE, withSubtree } from "~/entity/filters";
import type { entityMetadata } from "~/entity/metadata";
import { shiftPlainDate, shiftPlainDateMonths } from "~/lib/household-date";

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
 * undefined when a dimension cannot be filtered: a choice
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
    const filter = choice?.filter;
    const spec = filter
      ? context.fields.find((entry) => entry.columnId === filter.columnId)
      : undefined;
    if (!filter || !spec || (key === FILTER_NONE && !filter.noValue))
      return undefined;
    const summary = context.groups.find(
      (entry) => entry.key === JSON.stringify(path.slice(0, depth + 1)),
    );
    if (
      dimension?.level !== undefined &&
      !spec.subtree &&
      summary?.subtree !== false
    )
      return undefined;
    // A hierarchy value matches its subtree; a section counting only the
    // value itself narrows to it exactly.
    let value: string | string[];
    if (choice?.dateKind) {
      if (spec.kind !== "range" || !spec.range) return undefined;
      if (key === FILTER_NONE) {
        if (!spec.range.presence) return undefined;
        value = "none";
      } else {
        const bucket = dimension?.bucket ?? "day";
        const next =
          bucket === "day" || bucket === "week"
            ? shiftPlainDate(key, bucket === "day" ? 1 : 7)
            : shiftPlainDateMonths(
                key,
                bucket === "month" ? 1 : bucket === "quarter" ? 3 : 12,
              );
        // Range predicates own household-local timestamp boundaries; keep the
        // bucket as calendar days, including DST and leap-day transitions.
        value = `${key}..${shiftPlainDate(next, -1)}`;
      }
    } else if (spec.kind === "boolean") {
      if (key !== "true" && key !== "false") return undefined;
      value = key;
    } else {
      value = spec.subtree
        ? withSubtree(
            [key],
            summary?.subtree === true,
            spec.subtreeDefault !== false,
          )
        : [key];
    }
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

/** The root-level section's exact record-exclusion filter. */
export function groupRootField(context: GroupDrillContext, key: string) {
  const dimension = context.groupBy?.[0];
  const choice = context.grouping.find((entry) => entry.key === dimension?.key);
  const filter = dimension?.bucket ? null : choice?.filter;
  const spec = filter
    ? context.fields.find((entry) => entry.columnId === filter.columnId)
    : undefined;
  const summary = context.groups.find(
    (entry) => entry.path.length === 1 && entry.path[0] === key,
  );
  if (
    dimension?.level !== undefined &&
    !spec?.subtree &&
    summary?.subtree !== false
  )
    return undefined;
  return filter && spec && (key !== FILTER_NONE || filter.noValue)
    ? { filter, spec, key }
    : undefined;
}

/** A grouped list's full-population summaries, for layouts that draw no rows. */
export interface GroupSummaryModel {
  metrics?: Record<string, ListGroupMetric>;
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
