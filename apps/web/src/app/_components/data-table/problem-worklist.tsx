import type { Entity } from "@cubby/schemas/entity";
import { useSearch } from "@tanstack/react-router";
import type { ColumnFiltersState, SortingState } from "@tanstack/react-table";

import { Badge } from "~/components/ui/badge";
import { problemQuery } from "~/entities/problem-registry";

const sameValue = (actual: unknown, expected: string | string[]): boolean =>
  Array.isArray(expected)
    ? Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((value, index) => actual[index] === value)
    : actual === expected;

/** Whether visible URL state still exactly represents the originating Problem. */
export function problemWorklistState(
  entity: Entity,
  worklist: unknown,
  filters: ColumnFiltersState,
  sorting: SortingState,
) {
  if (typeof worklist !== "string") return undefined;
  const query = problemQuery(worklist as Parameters<typeof problemQuery>[0]);
  if (query?.source.kind !== "entity" || query.source.entity !== entity) {
    return undefined;
  }

  const filtersMatch =
    filters.length === query.source.filters.length &&
    query.source.filters.every((filter) =>
      sameValue(
        filters.find((candidate) => candidate.id === filter.id)?.value,
        filter.value,
      ),
    );
  const expectedSort = query.source.sort ?? [];
  const sortMatch =
    sorting.length === expectedSort.length &&
    expectedSort.every(
      (sort, index) =>
        sorting[index]?.id === sort.id && sorting[index]?.desc === sort.desc,
    );

  return { query, exact: filtersMatch && sortMatch };
}

/** Compact source indicator: exact at arrival, explicitly modified after edits. */
export function ProblemWorklistStatus({
  entity,
  filters,
  sorting,
}: {
  entity: Entity;
  filters: ColumnFiltersState;
  sorting: SortingState;
}) {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const state = problemWorklistState(entity, search.worklist, filters, sorting);
  if (!state) return null;
  return (
    <Badge variant={state.exact ? "secondary" : "outline"} className="shrink-0">
      {state.exact
        ? `From Problems: ${state.query.title}`
        : "Problem worklist modified"}
    </Badge>
  );
}
