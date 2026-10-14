import type { activityAttempt, activityEvent } from "@cubby/schemas/activity";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { CopyIcon } from "@phosphor-icons/react/dist/csr/Copy";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment, useEffect, useMemo } from "react";
import type { z } from "zod";

import { RunWorkFacts } from "~/app/runs/run-work-summary";
import { EntityIcon } from "~/entity/entities";
import { InspectorChrome } from "~/entity/entity-detail/inspector-frame";
import { cursorQueryOptions } from "~/integrations/tanstack-query/cursor-query-options";
import { activity } from "~/integrations/tanstack-query/generated/catalog.gen";
import { copyText } from "~/lib/clipboard";
import { AiCost } from "~/ui/common/ai-cost";
import { DateDisplay } from "~/ui/common/date-display";
import {
  RecordDetail,
  RecordDot,
  RecordHeading,
  RecordList,
  RecordRow,
  type RecordTone,
} from "~/ui/common/record-list";
import { Row, SectionHeading } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import { StatusText } from "~/ui/primitives/status-text";

import { WorkStateDot, workIssueText, workStateLabel } from "./work-state";

/** Image jobs are not entities, so their inspector is the one Activity row without a manifest record. */
export function ActivityRunDetail({
  id,
  onClose,
  variant = "page",
}: {
  id: string;
  onClose: () => void;
  variant?: "page" | "inspector";
}) {
  const detail = useInfiniteQuery(
    cursorQueryOptions(
      activity.detail,
      { id, limit: 20 },
      (page) => page.nextAttemptCursor,
    ),
  );
  const run = detail.data?.pages[0]?.run;
  return (
    <InspectorChrome
      label="Image job inspector"
      id={id}
      name={run?.workLabel ?? "Image job"}
      className={
        variant === "page" ? "mt-4 h-auto max-w-4xl rounded-md border" : ""
      }
      leading={
        run ? (
          <EntityIcon
            entity={run.iconEntity}
            colored
            className="mt-0.5 size-4"
          />
        ) : null
      }
      eyebrow={
        run ? (
          <span className="flex flex-wrap items-center gap-x-1.5 text-2xs font-medium text-muted-foreground">
            Image job
            <span aria-hidden="true">·</span>
            <WorkStateDot state={run.state} />
            {workStateLabel(run.state)}
            <span aria-hidden="true">·</span>
            <DateDisplay timestamp={run.createdAt} />
          </span>
        ) : null
      }
      actions={
        variant === "inspector" ? (
          <Button
            variant="ghost"
            size="xs"
            mobileSize="compact"
            nativeButton={false}
            render={<Link to="/runs/jobs/$id" params={{ id }} />}
          >
            Open record <ArrowSquareOutIcon />
          </Button>
        ) : null
      }
      onClose={onClose}
    >
      <div className="flex flex-col gap-3 p-3">
        {run ? <RunWorkFacts run={run} /> : null}
        {run?.parentRunId ? (
          <Link
            className="text-primary hover:underline"
            to="/runs/$shortcode"
            params={{ shortcode: run.parentRunId }}
          >
            Parent {run.parentRunId}
          </Link>
        ) : null}
        {detail.isError ? (
          <StatusText tone="destructive">{detail.error.message}</StatusText>
        ) : null}
        {run && workIssueText(run) ? (
          <StatusText tone={run.state === "skipped" ? "muted" : "destructive"}>
            {workIssueText(run)}
          </StatusText>
        ) : null}
        {run ? (
          <AiCost
            cost={run}
            note={
              run.parentRunId
                ? "This job’s cost may already be included in its parent Run total."
                : undefined
            }
          />
        ) : null}
        <ActivityTimeline id={id} />
      </div>
    </InspectorChrome>
  );
}

/** An image job's attempts and events, polled while the job is active. */
function ActivityTimeline({ id }: { id: string }) {
  const detail = useInfiniteQuery(
    cursorQueryOptions(
      activity.detail,
      { id, limit: 20 },
      (page) => page.nextAttemptCursor,
    ),
  );
  const events = useInfiniteQuery(
    cursorQueryOptions(activity.events, { id, limit: 20 }),
  );
  const attempts = useMemo(
    () => detail.data?.pages.flatMap((page) => page.attempts) ?? [],
    [detail.data],
  );
  const eventRows = useMemo(
    () => events.data?.pages.flatMap((page) => page.items) ?? [],
    [events.data],
  );
  const run = detail.data?.pages[0]?.run;
  useEffect(() => {
    if (!run?.active) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void detail.refetch();
      void events.refetch();
    }, 15_000);
    return () => window.clearInterval(interval);
  }, [detail, events, run?.active]);

  return (
    <section className="flex flex-col gap-1">
      <SectionHeading
        as="h3"
        actions={
          <Button
            variant="ghost"
            size="icon-xs"
            mobileSize="compact"
            aria-label="Refresh timeline"
            title="Refresh timeline"
            onClick={() => {
              void detail.refetch();
              void events.refetch();
            }}
          >
            <ArrowClockwiseIcon />
          </Button>
        }
        title="Attempts and events"
      />
      <RecordList
        variant="timeline"
        aria-label="Work timeline"
        // Loaded attempts stay readable while events load or fail; their state shows below.
        state={
          events.isPending && attempts.length === 0
            ? { status: "pending" }
            : { status: "success" }
        }
        empty={events.isSuccess ? "No events have been recorded." : undefined}
        footer={
          detail.hasNextPage || events.hasNextPage ? (
            <Row gap="xs" wrap>
              {detail.hasNextPage ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void detail.fetchNextPage()}
                  disabled={detail.isFetchingNextPage}
                >
                  Load more attempts
                </Button>
              ) : null}
              {events.hasNextPage ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void events.fetchNextPage()}
                  disabled={events.isFetchingNextPage}
                >
                  Load more events
                </Button>
              ) : null}
            </Row>
          ) : null
        }
      >
        {timelineGroups(attempts, eventRows).map((group) => (
          <Fragment key={group.number ?? "job"}>
            {group.number === null ? (
              attempts.length > 0 ? (
                <RecordHeading label="Job events" />
              ) : null
            ) : (
              <RecordHeading
                label={
                  <>
                    Attempt #{group.number}
                    {group.attempt ? (
                      <>
                        {" "}
                        · {workStateLabel(group.attempt.state)} ·{" "}
                        <DateDisplay
                          timestamp={group.attempt.startedAt}
                          clock="day"
                        />
                      </>
                    ) : null}
                  </>
                }
              />
            )}
            {group.attempt ? <AttemptRow attempt={group.attempt} /> : null}
            {group.events.map((event) => (
              <EventRow key={event.id} event={event} />
            ))}
          </Fragment>
        ))}
      </RecordList>
      {events.isPending && attempts.length > 0 ? (
        <RecordList
          aria-label="Events"
          state={{ status: "pending", rows: 1 }}
        />
      ) : null}
      {events.isError ? (
        <RecordList
          aria-label="Events"
          state={{
            status: "error",
            error: events.error,
            title: "Events failed to load",
            onRetry: () => void events.refetch(),
          }}
        />
      ) : null}
    </section>
  );
}

type ActivityAttempt = z.infer<typeof activityAttempt>;
type ActivityEvent = z.infer<typeof activityEvent>;

/**
 * Events grouped under the attempt that wrote them, newest attempt first; events without an
 * attempt (Run operations, job-level events) form one trailing group. Attempts and events page
 * independently, so a group may hold events whose attempt has not loaded yet.
 */
function timelineGroups(
  attempts: readonly ActivityAttempt[],
  events: readonly ActivityEvent[],
) {
  const numbers = new Set<number | null>([
    ...attempts.map((attempt) => attempt.number),
    ...events.map((event) => event.attempt),
  ]);
  return [...numbers]
    .sort((a, b) => (b ?? 0) - (a ?? 0))
    .map((number) => ({
      number,
      attempt:
        number === null
          ? undefined
          : attempts.find((attempt) => attempt.number === number),
      events: events.filter((event) => event.attempt === number),
    }));
}

function AttemptRow({ attempt }: { attempt: ActivityAttempt }) {
  const label = workStateLabel(attempt.state);
  return (
    <RecordRow
      leading={<WorkStateDot state={attempt.state} />}
      primary={<span className="font-medium">{label}</span>}
      secondary={
        attempt.error ??
        (attempt.diagnosticsJson || attempt.resultJson
          ? null
          : "No historical diagnostics were recorded for this attempt.")
      }
      clip={false}
      trailing={
        attempt.completedAt ? (
          <DateDisplay timestamp={attempt.completedAt} clock="day" />
        ) : null
      }
      actions={
        attempt.diagnosticsJson || attempt.resultJson ? (
          <span className="-ml-2 flex flex-wrap gap-0.5 @min-[32rem]/ledger:ml-0">
            {attempt.diagnosticsJson ? (
              <CopyButton text={attempt.diagnosticsJson}>
                Copy diagnostics
              </CopyButton>
            ) : null}
            {attempt.resultJson ? (
              <CopyButton text={attempt.resultJson}>Copy result</CopyButton>
            ) : null}
          </span>
        ) : null
      }
      detail={
        attempt.diagnosticsJson || attempt.resultJson ? (
          <RecordDetail summary="Diagnostics and result">
            {attempt.diagnosticsJson ? (
              <JsonBlock label="Diagnostics" json={attempt.diagnosticsJson} />
            ) : null}
            {attempt.resultJson ? (
              <JsonBlock label="Result" json={attempt.resultJson} />
            ) : null}
          </RecordDetail>
        ) : null
      }
    />
  );
}

const EVENT_TONE = {
  info: undefined,
  debug: "muted",
  error: "destructive",
} as const satisfies Record<ActivityEvent["level"], RecordTone | undefined>;

function EventRow({ event }: { event: ActivityEvent }) {
  return (
    <RecordRow
      leading={<RecordDot tone={EVENT_TONE[event.level]} label={event.level} />}
      primary={<code className="font-mono text-xs">{event.event}</code>}
      secondary={event.source}
      trailing={<DateDisplay timestamp={event.occurredAt} clock="day" />}
      actions={
        event.detailsJson ? (
          <CopyButton text={event.detailsJson}>Copy diagnostics</CopyButton>
        ) : null
      }
      detail={
        event.detailsJson ? (
          <RecordDetail summary="Diagnostics">
            <JsonBlock json={event.detailsJson} />
          </RecordDetail>
        ) : null
      }
    />
  );
}

function CopyButton({ text, children }: { text: string; children: string }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-6"
      onClick={() => void copyText(text)}
    >
      <CopyIcon />
      {children}
    </Button>
  );
}

function JsonBlock({ label, json }: { label?: string; json: string }) {
  return (
    <>
      {label ? <h4 className="mt-1 font-medium">{label}</h4> : null}
      <pre className="max-h-80 overflow-auto bg-muted/30 p-2 font-mono break-words whitespace-pre-wrap">
        {json}
      </pre>
    </>
  );
}
