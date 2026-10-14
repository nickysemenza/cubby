import type { activityAttempt, activityEvent } from "@cubby/schemas/activity";
import { CopyIcon } from "@phosphor-icons/react/dist/csr/Copy";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Fragment, useEffect, useMemo } from "react";
import type { z } from "zod";

import { RunWorkFacts } from "~/app/runs/run-work-summary";
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
import { Row } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/ui/primitives/card";
import { StatusText } from "~/ui/primitives/status-text";

import { WorkStateDot, workIssueText, workStateLabel } from "./work-state";

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
    <Card
      className={
        variant === "inspector"
          ? "h-full rounded-none border-0 shadow-none"
          : "mt-4 max-w-4xl"
      }
    >
      <CardHeader>
        <Row justify="between" align="start" gap="sm" wrap>
          <div>
            <CardTitle>{run?.workLabel ?? "Work detail"}</CardTitle>
            <CardDescription>
              {run ? (
                <>
                  {run.id} · {run.recordType === "run" ? "Run" : "Image job"} ·{" "}
                  {workStateLabel(run.state)} ·{" "}
                  <DateDisplay timestamp={run.createdAt} />
                </>
              ) : (
                id
              )}
            </CardDescription>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            Close
          </Button>
        </Row>
      </CardHeader>
      <CardContent>
        {run ? <RunWorkFacts run={run} /> : null}
        <Row gap="sm" wrap>
          {id.startsWith("RUN-") ? (
            <a className="text-primary hover:underline" href={`/runs/${id}`}>
              Full details
            </a>
          ) : (
            <a
              className="text-primary hover:underline"
              href={`/runs/jobs/${id}`}
            >
              Full details
            </a>
          )}
          {run?.parentRunId ? (
            <a
              className="text-primary hover:underline"
              href={`/runs/${run.parentRunId}`}
            >
              Parent {run.parentRunId}
            </a>
          ) : null}
          <Button variant="ghost" size="sm" onClick={() => void copyText(id)}>
            <CopyIcon />
            Copy ID
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void detail.refetch();
              void events.refetch();
            }}
          >
            Refresh details
          </Button>
        </Row>
        {detail.isError ? (
          <StatusText tone="destructive">{detail.error.message}</StatusText>
        ) : null}
        {run && workIssueText(run) ? (
          <StatusText tone={run.state === "skipped" ? "muted" : "destructive"}>
            {workIssueText(run)}
          </StatusText>
        ) : null}
        {run ? (
          <div className="mt-3">
            <AiCost
              cost={run}
              note={
                run.recordType === "image_job" && run.parentRunId
                  ? "This job’s cost may already be included in its parent Run total."
                  : undefined
              }
            />
          </div>
        ) : null}
        <section className="mt-3 flex flex-col gap-1">
          <h3 className="font-medium">
            {run?.recordType === "image_job"
              ? "Attempts and events"
              : run?.recordType === "run"
                ? "Operations and events"
                : "Events"}
          </h3>
          <RecordList
            variant="timeline"
            aria-label="Work timeline"
            // Loaded attempts stay readable while events load or fail; their state shows below.
            state={
              events.isPending && attempts.length === 0
                ? { status: "pending" }
                : { status: "success" }
            }
            empty={
              events.isSuccess ? "No events have been recorded." : undefined
            }
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
      </CardContent>
    </Card>
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
