import type { Entity } from "@cubby/schemas/entity";
import type { DetailActivityEvent } from "@cubby/schemas/entity-detail-data";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import {
  type AuditableEntity,
  isAuditableEntity,
  shortcodeEntities,
} from "@cubby/schemas/entity-manifest";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import {
  entityDetailLink,
  EntityIcon,
  isBrowserRoutedEntity,
} from "~/entity/entities";
import { formatCalendarDay, formatInstant } from "~/lib/date-format";
import { formatCurrency } from "~/lib/number-format";
import { RecordList, RecordMore, RecordRow } from "~/ui/common/record-list";
import { useHydrated } from "~/ui/hooks/use-hydrated";
import { SectionHeading } from "~/ui/layout";

import { AuditLogList } from "../audit-log/audit-log-list";
import { useDetailActivity } from "./use-detail-data";

function linkOf(event: DetailActivityEvent) {
  const { entity, shortcode } = event;
  if (event.kind !== "record" || !shortcode || !isBrowserRoutedEntity(entity))
    return null;
  const routed = shortcodeEntities.find((candidate) => candidate === entity);
  return routed && isBrowserRoutedEntity(routed)
    ? entityDetailLink(routed, shortcode)
    : null;
}

const changeVerb = (action: string) =>
  action === "create"
    ? "Created"
    : action === "update"
      ? "Updated"
      : action === "delete"
        ? "Deleted"
        : action;

/** Audit rows carry the action and changed keys; show the verb and labels. */
function changeText(event: DetailActivityEvent) {
  const fields: readonly { key: string; label: string }[] =
    entityFieldModels[event.entity].fields;
  const labels = event.subtitle
    ?.split(", ")
    .map((key) => fields.find((field) => field.key === key)?.label ?? key)
    .join(", ");
  return { title: changeVerb(event.title), subtitle: labels };
}

/**
 * One newest-first timeline: dated records from the entity's declared
 * activity relations merged with the record's own change history.
 */
export function DetailActivity({ entity, id }: { entity: Entity; id: string }) {
  const hydrated = useHydrated();
  const activity = useDetailActivity(
    { source: { entityKind: entity, entityId: id }, limit: 8 },
    hydrated,
  );
  const events = activity.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <section
      // The page's established activity anchor: `#history` links keep working.
      id="history"
      aria-label="Activity"
      data-detail-group
      tabIndex={-1}
      className="min-w-0 scroll-mt-[calc(var(--app-chrome-top)+3rem)] focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      data-testid="detail-activity"
    >
      <SectionHeading title="Activity" />
      <RecordList
        aria-label="Recent changes and spend"
        empty="No activity yet."
        state={
          activity.isError
            ? { status: "error", error: activity.error, title: "activity" }
            : activity.isPending
              ? { status: "pending" }
              : { status: "success" }
        }
      >
        {events.map((event) => {
          const link = linkOf(event);
          const { title, subtitle } =
            event.kind === "change"
              ? changeText(event)
              : { title: event.title, subtitle: event.subtitle };
          return (
            <RecordRow
              key={event.id}
              leading={
                <time
                  dateTime={event.allDay ? event.date.slice(0, 10) : event.date}
                  title={
                    event.allDay
                      ? formatCalendarDay(event.date.slice(0, 10), "dateShort")
                      : formatInstant(event.date, "dateShortTime")
                  }
                  className="inline-block w-12 font-mono text-xs whitespace-nowrap text-muted-foreground tabular-nums"
                >
                  {(event.allDay
                    ? formatCalendarDay(event.date.slice(0, 10), "dateShort")
                    : formatInstant(event.date, "dateShort")
                  ).replace(/, \d{4}$/, "")}
                </time>
              }
              primary={
                <>
                  {event.kind === "record" ? (
                    <EntityIcon
                      entity={event.entity}
                      aria-hidden
                      className="size-3.5 shrink-0 text-muted-foreground"
                    />
                  ) : null}
                  {link ? (
                    <Link
                      {...link}
                      className="truncate font-medium text-foreground-strong underline-offset-2 hover:underline"
                    >
                      {title}
                    </Link>
                  ) : (
                    <span
                      className={
                        event.kind === "change"
                          ? "truncate text-muted-foreground"
                          : "truncate font-medium text-foreground-strong"
                      }
                    >
                      {title}
                    </span>
                  )}
                </>
              }
              secondary={subtitle}
              trailing={
                event.amountCents === undefined ? undefined : (
                  <span className="font-mono text-foreground-strong tabular-nums">
                    {formatCurrency(event.amountCents / 100)}
                  </span>
                )
              }
            />
          );
        })}
        {activity.hasNextPage ? (
          <RecordMore
            label={activity.isFetchingNextPage ? "Loading…" : "Show older"}
            onClick={() => void activity.fetchNextPage()}
          />
        ) : null}
      </RecordList>
      {isAuditableEntity(entity) ? (
        <ChangeDetails entity={entity} id={id} />
      ) : null}
    </section>
  );
}

/** The full audit trail behind the summarized change rows: previous and
 * applied values, actor, and Run provenance. Queried only once opened. */
function ChangeDetails({
  entity,
  id,
}: {
  entity: AuditableEntity;
  id: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="mt-2 text-sm"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="w-fit cursor-pointer rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground-strong focus-visible:ring-2 focus-visible:ring-ring">
        Change details
      </summary>
      {open ? (
        <div className="mt-2">
          <AuditLogList
            entityKind={entity}
            entityId={id}
            showEntityLink={false}
          />
        </div>
      ) : null}
    </details>
  );
}
