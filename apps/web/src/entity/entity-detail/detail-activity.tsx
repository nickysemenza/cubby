import type { Entity } from "@cubby/schemas/entity";
import type { DetailActivityEvent } from "@cubby/schemas/entity-detail-data";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import {
  type AuditableEntity,
  isAuditableEntity,
} from "@cubby/schemas/entity-manifest";
import { useState } from "react";

import { EntityAuditLink } from "~/entity/components/entity-ref-link";
import { formatCalendarDay, formatInstant } from "~/lib/date-format";
import { dateSpanParts } from "~/lib/date-span";
import { householdLocalDate } from "~/lib/household-date";
import { formatCurrency } from "~/lib/number-format";
import {
  RecordDot,
  RecordList,
  RecordMore,
  RecordRow,
} from "~/ui/common/record-list";
import { useHouseholdToday } from "~/ui/hooks/use-household-today";
import { useHydrated } from "~/ui/hooks/use-hydrated";
import { Section } from "~/ui/layout";

import { AuditLogList } from "../audit-log/audit-log-list";
import { useDetailActivity } from "./use-detail-data";

const changeVerb = (action: string) =>
  action === "create"
    ? "Created"
    : action === "update"
      ? "Updated"
      : action === "delete"
        ? "Deleted"
        : action;

function activityDay(event: DetailActivityEvent) {
  return event.allDay
    ? event.date.slice(0, 10)
    : householdLocalDate(new Date(event.date));
}

function groupActivityByDay(events: readonly DetailActivityEvent[]) {
  const groups: { day: string; events: DetailActivityEvent[] }[] = [];
  for (const event of events) {
    const day = activityDay(event);
    const last = groups.at(-1);
    if (last?.day === day) last.events.push(event);
    else groups.push({ day, events: [event] });
  }
  return groups;
}

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
  const groups = groupActivityByDay(events);
  const today = useHouseholdToday() ?? householdLocalDate();
  return (
    <Section
      // The page's established activity anchor: `#history` links keep working.
      id="history"
      title="Activity"
      headingAs="h2"
      data-detail-group
      tabIndex={-1}
      className="scroll-mt-[calc(var(--app-chrome-top)+3rem)] focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      data-testid="detail-activity"
    >
      {activity.isError || activity.isPending ? (
        <RecordList
          aria-label="Recent changes and spend"
          state={
            activity.isError
              ? { status: "error", error: activity.error, title: "activity" }
              : { status: "pending" }
          }
        />
      ) : events.length === 0 ? (
        <RecordList
          aria-label="Recent changes and spend"
          empty="No activity yet."
        />
      ) : (
        <div className="space-y-2.5" aria-label="Recent changes and spend">
          {groups.map(({ day, events: dayEvents }) => (
            <div
              key={day}
              className="grid grid-cols-[6rem_minmax(0,1fr)] items-start"
            >
              <div>
                <time
                  dateTime={day}
                  className="text-xs/4 font-medium text-foreground-strong tabular-nums"
                >
                  {formatCalendarDay(
                    day,
                    day.startsWith(today.slice(0, 4))
                      ? "monthDay"
                      : "dateShort",
                  )}
                </time>
                <div className="text-xs/4 text-muted-foreground">
                  {dateSpanParts(day, null, today).relative}
                </div>
              </div>
              <RecordList
                variant="timeline"
                aria-label={`${formatCalendarDay(day, "dateShort")} activity`}
              >
                {dayEvents.map((event) => {
                  const { title, subtitle } =
                    event.kind === "change"
                      ? changeText(event)
                      : { title: event.title, subtitle: event.subtitle };
                  const primary =
                    event.kind === "record" && event.shortcode ? (
                      <EntityAuditLink
                        entityKind={event.entity}
                        entityId={event.shortcode}
                        name={title}
                        displayImage={null}
                        compact
                      />
                    ) : (
                      <span className="font-medium text-foreground-strong">
                        {title}
                      </span>
                    );
                  return (
                    <RecordRow
                      key={event.id}
                      stacked
                      leading={
                        event.kind === "change" ? (
                          <RecordDot
                            label={title}
                            color={
                              event.title === "update"
                                ? "var(--action-change)"
                                : undefined
                            }
                            spoken={false}
                            tone={
                              event.title === "create"
                                ? "positive"
                                : event.title === "delete"
                                  ? "destructive"
                                  : undefined
                            }
                          />
                        ) : undefined
                      }
                      primary={
                        <>
                          {primary}
                          {event.kind === "change" && subtitle ? (
                            <span className="text-xs text-muted-foreground">
                              {subtitle}
                            </span>
                          ) : null}
                        </>
                      }
                      secondary={event.kind === "record" ? subtitle : undefined}
                      trailing={
                        event.amountCents !== undefined ? (
                          <span className="font-mono text-foreground-strong tabular-nums">
                            {formatCurrency(event.amountCents / 100)}
                          </span>
                        ) : event.allDay ? undefined : (
                          <time
                            dateTime={event.date}
                            className="font-mono text-xs text-muted-foreground tabular-nums"
                          >
                            {formatInstant(event.date, "clock")}
                          </time>
                        )
                      }
                    />
                  );
                })}
              </RecordList>
            </div>
          ))}
          {activity.hasNextPage ? (
            <div className="grid grid-cols-[6rem_minmax(0,1fr)]">
              <span aria-hidden />
              <RecordList aria-label="Older activity">
                <RecordMore
                  label={
                    activity.isFetchingNextPage ? "Loading…" : "Show older"
                  }
                  onClick={() => void activity.fetchNextPage()}
                />
              </RecordList>
            </div>
          ) : null}
        </div>
      )}
      {isAuditableEntity(entity) ? (
        <ChangeDetails entity={entity} id={id} />
      ) : null}
    </Section>
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
