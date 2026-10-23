import { entitySummary } from "@cubby/schemas/entity-summary";
import type { WorkQueueRow } from "@cubby/schemas/work-queue";
import { Link } from "@tanstack/react-router";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { entities, isBrowserRoutedEntity } from "~/entity/entities";
import { cn } from "~/lib/utils";

type WorkRowSource = Pick<
  WorkQueueRow,
  "entity" | "id" | "name" | "source" | "suggestionFamily"
>;

/**
 * A Suggestion row opens the Suggestions page: a family row on that family,
 * a record's row on that record's Suggestions.
 */
export function suggestionsSearch(row: WorkRowSource) {
  if (row.suggestionFamily) return { family: row.suggestionFamily };
  if (row.source !== "suggestion" || row.entity === null || row.id === null)
    return null;
  return { record: `${row.entity}:${row.id}` };
}

/** Where a row's Open goes: Suggestions, its record, or Problems. */
export function workRowHref(row: WorkRowSource) {
  const suggestions = suggestionsSearch(row);
  if (suggestions)
    return `/suggestions?${new URLSearchParams(
      "family" in suggestions && suggestions.family
        ? { family: suggestions.family }
        : { record: suggestions.record ?? "" },
    ).toString()}`;
  if (row.entity === null || row.id === null) return "/problems";
  return isBrowserRoutedEntity(row.entity)
    ? `/${entities[row.entity].basePath}/${row.id}`
    : undefined;
}

/** The record's singular label; Problems and Suggestion families have none. */
export function workRowType(row: Pick<WorkQueueRow, "entity">) {
  return row.entity ? entitySummary[row.entity].singular : null;
}

const LINK_CLASS =
  "truncate font-medium text-foreground underline-offset-2 outline-none hover:text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring";

/** The row's name as a link to wherever its work happens. */
export function WorkRowLink({
  row,
  className,
}: {
  row: WorkRowSource;
  className?: string;
}) {
  const suggestions = suggestionsSearch(row);
  if (suggestions)
    return (
      <Link
        to="/suggestions"
        search={suggestions}
        title={row.name}
        className={cn(LINK_CLASS, className)}
      >
        {row.name}
      </Link>
    );
  if (row.entity === null || row.id === null)
    return (
      <Link
        to="/problems"
        title={row.name}
        className={cn(LINK_CLASS, className)}
      >
        {row.name}
      </Link>
    );
  return isBrowserRoutedEntity(row.entity) ? (
    <EntityRefLink entity={row.entity} id={row.id} name={row.name} bare />
  ) : (
    <span className={cn("truncate font-medium", className)}>{row.name}</span>
  );
}
