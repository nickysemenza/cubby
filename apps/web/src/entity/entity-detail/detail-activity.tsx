import type { Entity } from "@cubby/schemas/entity";
import type { DetailActivityEvent } from "@cubby/schemas/entity-detail-data";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
import { Link } from "@tanstack/react-router";

import {
  entityDetailLink,
  EntityIcon,
  isBrowserRoutedEntity,
} from "~/entity/entities";
import { formatInstant } from "~/lib/date-format";
import { formatCurrency } from "~/lib/number-format";
import { RecordList, RecordMore, RecordRow } from "~/ui/common/record-list";
import { useHydrated } from "~/ui/hooks/use-hydrated";
import { SectionHeading } from "~/ui/layout";

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
  if (activity.isSuccess && events.length === 0) return null;
  return (
    <section
      id="activity"
      aria-label="Activity"
      className="min-w-0 scroll-mt-[var(--app-chrome-top)]"
      data-testid="detail-activity"
    >
      <SectionHeading title="Activity" />
      <RecordList
        aria-label="Recent changes and spend"
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
                  dateTime={event.date}
                  title={formatInstant(event.date, "dateShortTime")}
                  className="inline-block w-12 font-mono text-xs whitespace-nowrap text-muted-foreground tabular-nums"
                >
                  {formatInstant(event.date, "dateShort").replace(
                    /, \d{4}$/,
                    "",
                  )}
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
    </section>
  );
}
