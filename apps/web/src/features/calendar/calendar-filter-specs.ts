import {
  calendarSources,
  calendarSourceEntity,
  type CalendarSourceKind,
} from "@cubby/schemas/calendar";
import {
  type QueryClient,
  useQueries,
  useQueryClient,
} from "@tanstack/react-query";
import { useMemo } from "react";

import {
  getEntityFilters,
  filterSpecLabel,
  type FilterSpec,
} from "~/entity/filter-manifest";
import { entityMetadata, entityMetadataQueryOptions } from "~/entity/metadata";

// SAFETY: calendarSources is exhaustive over the CalendarSourceKind union.
export const calendarKinds = Object.keys(
  calendarSources,
) as CalendarSourceKind[];
export const calendarFilterKey = (kind: CalendarSourceKind, key: string) =>
  `${kind}.${key}`;

export function calendarEntityFilterSpecs(
  queryClient: QueryClient,
  kind: CalendarSourceKind,
): readonly FilterSpec[] {
  const entity = calendarSourceEntity(kind);
  const primary = entityMetadata(queryClient, entity).summary.primarySearch;
  return [
    ...(primary
      ? [
          {
            columnId: primary.key,
            kind: "text" as const,
            placeholder: primary.placeholder,
            label: "Search",
          },
        ]
      : []),
    ...getEntityFilters(queryClient, entity),
  ];
}

/** Namespacing changes addresses and labels, never the source's filter rules. */
const calendarFilterSpecs = (
  queryClient: QueryClient,
): readonly FilterSpec[] => [
  {
    columnId: "kinds",
    kind: "multiselect",
    label: "Show",
    placeholder: "Filter by item kind...",
    options: calendarKinds.map((kind) => ({
      value: kind,
      label:
        kind === "spending"
          ? "Spending"
          : entityMetadata(queryClient, calendarSourceEntity(kind)).summary
              .plural,
    })),
  },
  ...calendarKinds.flatMap((kind) =>
    calendarEntityFilterSpecs(queryClient, kind).map((spec) => ({
      ...spec,
      columnId: calendarFilterKey(kind, spec.columnId),
      urlKey: calendarFilterKey(kind, spec.urlKey ?? spec.columnId),
      exclude: spec.exclude && {
        ...spec.exclude,
        field: calendarFilterKey(kind, spec.exclude.field),
      },
      match: spec.match && { field: calendarFilterKey(kind, spec.match.field) },
      aliasOf: spec.aliasOf ? calendarFilterKey(kind, spec.aliasOf) : undefined,
      subtree: spec.subtree ? calendarFilterKey(kind, spec.subtree) : undefined,
      exclusiveGroup: spec.exclusiveGroup
        ? calendarFilterKey(kind, spec.exclusiveGroup)
        : undefined,
      group:
        kind === "spending"
          ? "Spending"
          : entityMetadata(queryClient, calendarSourceEntity(kind)).summary
              .plural,
      label: `${kind === "spending" ? "Spending" : entityMetadata(queryClient, calendarSourceEntity(kind)).summary.singular} ${filterSpecLabel(spec).toLowerCase()}`,
    })),
  ),
];

export const calendarScheduleFilterSpecs = (specs: readonly FilterSpec[]) =>
  specs.map((spec) => ({
    ...spec,
    unsupportedReason:
      spec.columnId === "kinds" ||
      spec.columnId.startsWith("task.") ||
      spec.columnId.startsWith("planting.")
        ? undefined
        : "Schedule shows only Tasks and Plantings.",
    options:
      spec.columnId === "kinds"
        ? spec.options?.filter(
            (option) => option.value === "task" || option.value === "planting",
          )
        : spec.options,
  }));

const calendarMetadataResults = (
  results: readonly { isPending: boolean; error: Error | null }[],
) => ({
  pending: results.some((result) => result.isPending),
  error: results.find((result) => result.error)?.error,
});

/** Non-entity Calendar admits just its declared source slices before compiling filters. */
export function useCalendarMetadata() {
  const state = useQueries({
    queries: calendarKinds.map((kind) =>
      entityMetadataQueryOptions(calendarSourceEntity(kind)),
    ),
    combine: calendarMetadataResults,
  });
  if (state.error) throw state.error;
  return !state.pending;
}

export function useCalendarFilterSpecs() {
  const queryClient = useQueryClient();
  const ready = useCalendarMetadata();
  return useMemo(
    () => (ready ? calendarFilterSpecs(queryClient) : undefined),
    [queryClient, ready],
  );
}
