import type { AuditLogListOut } from "@cubby/schemas/audit";
import { humanize } from "@cubby/shared";
import { useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { differenceInCalendarDays, parseISO } from "date-fns";
import { uniqBy } from "es-toolkit";
import { Fragment, useMemo } from "react";

import { summarizeChanges } from "~/entity/audit-log/audit-log-entry";
import { foldAuditEntries } from "~/entity/audit-log/audit-log-fold";
import type { AuditLogListOperations } from "~/entity/audit-log/audit-log-list";
import { EntityAuditLink } from "~/entity/components/entity-ref-link";
import { EntityDisplayImagesProvider } from "~/entity/entity-media/entity-display-images";
import { cursorQueryOptions } from "~/integrations/tanstack-query/cursor-query-options";
import { auditLog } from "~/integrations/tanstack-query/generated/catalog/auditLog.gen";
import { formatCalendarDay } from "~/lib/date-format";
import { householdLocalDate } from "~/lib/household-date";
import { getStatusBadgeProps } from "~/lib/status-colors";
import { DateDisplay } from "~/ui/common/date-display";
import { EmptyState } from "~/ui/feedback/empty-state";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { QuerySection } from "~/ui/feedback/query-section";
import { useHydrated } from "~/ui/hooks/use-hydrated";
import { Section } from "~/ui/layout";
import { Skeleton } from "~/ui/primitives/skeleton";

type AuditEntry = AuditLogListOut["entries"][number];

export interface RecentActivityFeedOperations {
  readonly auditLog: AuditLogListOperations;
}

const GUTTER = "grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 max-sm:grid-cols-1";

/**
 * Home's "What changed": the latest recorded changes grouped by household
 * day, the day in a quiet gutter, then one line per change. The audit read
 * streams independently with the authenticated route's first screen.
 */
export function RecentActivityFeed({
  limit = 6,
  operations,
}: {
  /** Entries per page; "Show older" reads the next page. */
  limit?: number;
  /** Audit operation boundary for browser tests. */
  operations?: RecentActivityFeedOperations;
}) {
  return (
    <Section
      title="What changed"
      headingAs="h2"
      actions={<Link to="/activity">View all</Link>}
    >
      <QuerySection
        title="recent activity"
        fallback={
          <div className="space-y-1.5 pt-1" data-testid="activity-placeholder">
            {Array.from({ length: 3 }, (_, index) => (
              <Skeleton
                key={index}
                data-testid="activity-placeholder-row"
                className="h-4.5 w-full"
              />
            ))}
          </div>
        }
      >
        <ChangesByDay limit={limit} operations={operations?.auditLog} />
      </QuerySection>
    </Section>
  );
}

function ChangesByDay({
  limit,
  operations = { list: auditLog.list },
}: {
  limit: number;
  operations?: AuditLogListOperations;
}) {
  const hydrated = useHydrated();
  const activity = useSuspenseInfiniteQuery(
    cursorQueryOptions(operations.list, { limit }),
  );
  const days = useMemo(() => {
    const entries = uniqBy(
      activity.data?.pages.flatMap((page) => page.entries) ?? [],
      (entry) => entry.entryKey,
    );
    const result: { day: string; groups: AuditEntry[][] }[] = [];
    for (const group of foldAuditEntries(entries)) {
      const day = householdLocalDate(new Date(group[0]!.createdAt));
      const last = result.at(-1);
      if (last?.day === day) last.groups.push(group);
      else result.push({ day, groups: [group] });
    }
    return result;
  }, [activity.data]);

  if (activity.isError)
    return (
      <ErrorDisplay
        error={activity.error}
        title="recent activity"
        onRetry={() => void activity.refetch()}
      />
    );
  if (activity.data === undefined)
    return (
      <div className="space-y-1.5 pt-1" aria-busy="true">
        <Skeleton className="h-4.5 w-full" />
        <Skeleton className="h-4.5 w-4/5" />
      </div>
    );
  if (days.length === 0)
    return (
      <EmptyState size="inline">
        No activity yet. Changes you make will appear here.
      </EmptyState>
    );

  const today = householdLocalDate(new Date());
  return (
    <EntityDisplayImagesProvider
      refs={(
        activity.data?.pages.flatMap((page) => page.entries) ?? []
      ).flatMap((entry) =>
        entry.entityId
          ? [{ entityKind: entry.entityKind, entityId: entry.entityId }]
          : [],
      )}
    >
      <div className="pt-0.5">
        <dl className={`${GUTTER} gap-y-2`}>
          {days.map(({ day, groups }) => (
            <Fragment key={day}>
              <dt className="text-xs/4.5">
                <span className="font-semibold text-foreground">
                  {dayLabel(day, today)}
                </span>
                <DayAge day={day} today={today} />
              </dt>
              <dd className="min-w-0">
                <ul aria-label={dayLabel(day, today)}>
                  {groups.map((group) => (
                    <ChangeLine key={group[0]?.entryKey} group={group} />
                  ))}
                </ul>
              </dd>
            </Fragment>
          ))}
        </dl>
        {activity.hasNextPage ? (
          <div className={`${GUTTER} pt-2`}>
            <button
              type="button"
              onClick={() =>
                void activity.fetchNextPage({ cancelRefetch: false })
              }
              disabled={!hydrated || activity.isFetchingNextPage}
              className="col-start-2 justify-self-start rounded-sm text-xs text-link outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring disabled:text-muted-foreground max-md:min-h-11 max-sm:col-start-1"
            >
              {activity.isFetchingNextPage ? "Loading…" : "Show older"}
            </button>
          </div>
        ) : null}
      </div>
    </EntityDisplayImagesProvider>
  );
}

function dayLabel(day: string, today: string) {
  const age = differenceInCalendarDays(parseISO(today), parseISO(day));
  if (age === 0) return "Today";
  if (age === 1) return "Yesterday";
  return formatCalendarDay(day, "monthDay");
}

/** Days past yesterday carry their age under the date, as in Activity. */
function DayAge({ day, today }: { day: string; today: string }) {
  const age = differenceInCalendarDays(parseISO(today), parseISO(day));
  if (age < 2) return null;
  return (
    <span className="block text-muted-foreground max-sm:ml-1.5 max-sm:inline">
      {age < 7 ? `${age} days ago` : formatCalendarDay(day, "monthYear")}
    </span>
  );
}

/** One change: the record, what happened to it, then its time. */
function ChangeLine({ group }: { group: AuditEntry[] }) {
  const [entry] = group;
  if (!entry) return null;
  const action = getStatusBadgeProps("audit", entry.action).label;
  // A burst reads as its newest diff merged over the older ones' fields.
  const changes =
    group.length > 1
      ? Object.assign(
          {},
          ...[...group].reverse().map((item) => item.changes ?? {}),
        )
      : entry.changes;
  const summary = entry.action === "update" ? summarizeChanges(changes) : null;
  const fields = summary?.shown.map((field) => humanize(field.field));
  return (
    <li className="flex min-w-0 items-baseline justify-between gap-3 text-sm/4.5">
      <span className="grid min-w-0 flex-1 grid-cols-1 items-center gap-x-3 sm:grid-cols-[minmax(0,1fr)_8rem]">
        {entry.entityId ? (
          <EntityAuditLink
            entityKind={entry.entityKind}
            entityId={entry.entityId}
            name={entry.entityName}
            displayImage={null}
            layout="row"
          />
        ) : null}
        <span className="min-w-0 truncate text-muted-foreground">
          {action.toLocaleLowerCase()}
          {group.length > 1 ? ` ${group.length}×` : ""}
          {fields?.length
            ? ` · ${fields.join(", ").toLocaleLowerCase()}${summary && summary.omitted > 0 ? ` +${summary.omitted}` : ""}`
            : ""}
        </span>
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">
        <DateDisplay timestamp={entry.createdAt} clock="time" stacked={false} />
      </span>
    </li>
  );
}
