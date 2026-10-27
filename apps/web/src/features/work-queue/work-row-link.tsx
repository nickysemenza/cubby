import { entitySummary } from "@cubby/schemas/entity-summary";
import type { WorkQueueRow } from "@cubby/schemas/work-queue";
import { Link } from "@tanstack/react-router";

import { EntityPill } from "~/entity/components/entity-pill";
import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { entities, isBrowserRoutedEntity } from "~/entity/entities";
import { cn } from "~/lib/utils";

type WorkRowSource = Pick<
  WorkQueueRow,
  "entity" | "id" | "name" | "link" | "reasonKeys"
>;

/** A Suggestion row's Suggestions search: its family, scoped to its record. */
export function suggestionsSearch(row: WorkRowSource) {
  if (row.link.kind !== "suggestions") return null;
  return {
    family: row.link.family,
    ...(row.entity && row.id ? { record: `${row.entity}:${row.id}` } : {}),
  };
}

/** A diagnostic row's queue search: its own reason group. */
export function reasonSearch(row: WorkRowSource) {
  const reason = row.reasonKeys[0];
  return row.link.kind === "reason" && reason ? { reason } : null;
}

/** Where a row's Open goes: Suggestions, its reason group, or its record. */
export function workRowHref(row: WorkRowSource) {
  const suggestions = suggestionsSearch(row);
  if (suggestions)
    return `/suggestions?${new URLSearchParams(suggestions).toString()}`;
  const reason = reasonSearch(row);
  if (reason) return `/work-queue?${new URLSearchParams(reason).toString()}`;
  if (row.entity === null || row.id === null) return undefined;
  return isBrowserRoutedEntity(row.entity)
    ? `/${entities[row.entity].basePath}/${row.id}`
    : undefined;
}

/** The record's singular label; a diagnostic count has none. */
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
        {row.entity && row.id ? (
          <EntityPill
            entity={row.entity}
            id={row.id}
            name={row.name}
            displayImage={null}
          />
        ) : (
          row.name
        )}
      </Link>
    );
  const reason = reasonSearch(row);
  if (reason)
    return (
      <Link
        to="/work-queue"
        search={reason}
        title={row.name}
        className={cn(LINK_CLASS, className)}
      >
        {row.name}
      </Link>
    );
  return row.entity && row.id && isBrowserRoutedEntity(row.entity) ? (
    <EntityRefLink
      entity={row.entity}
      id={row.id}
      name={row.name}
      className={cn("max-w-full min-w-0", className)}
    />
  ) : (
    <span className={cn("truncate font-medium", className)}>{row.name}</span>
  );
}
