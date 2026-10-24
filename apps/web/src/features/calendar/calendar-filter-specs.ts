import {
  calendarSources,
  calendarSourceEntity,
  type CalendarSourceKind,
} from "@cubby/schemas/calendar";
import { entitySummary } from "@cubby/schemas/entity-summary";

import {
  getEntityFilters,
  filterSpecLabel,
  type FilterSpec,
} from "~/entity/filter-manifest";

// SAFETY: calendarSources is exhaustive over the CalendarSourceKind union.
export const calendarKinds = Object.keys(
  calendarSources,
) as CalendarSourceKind[];
export const calendarFilterKey = (kind: CalendarSourceKind, key: string) =>
  `${kind}.${key}`;

export const calendarEntityFilterSpecs = Object.fromEntries(
  calendarKinds.map((kind) => {
    const entity = calendarSourceEntity(kind);
    const primary = entitySummary[entity].primarySearch;
    const specs: readonly FilterSpec[] = [
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
      ...getEntityFilters(entity),
    ];
    return [kind, specs];
  }),
);

/** Namespacing changes addresses and labels, never the source's filter rules. */
export const calendarFilterSpecs: readonly FilterSpec[] = [
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
          : entitySummary[calendarSourceEntity(kind)].plural,
    })),
  },
  ...calendarKinds.flatMap((kind) =>
    calendarEntityFilterSpecs[kind]!.map((spec) => ({
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
          : entitySummary[calendarSourceEntity(kind)].plural,
      label: `${kind === "spending" ? "Spending" : entitySummary[calendarSourceEntity(kind)].singular} ${filterSpecLabel(spec).toLowerCase()}`,
    })),
  ),
];

export const calendarScheduleFilterSpecs = calendarFilterSpecs.map((spec) => ({
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
