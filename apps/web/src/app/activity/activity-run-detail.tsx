import type { ActivityRun } from "@cubby/schemas/activity";
import { CopyIcon } from "@phosphor-icons/react/dist/csr/Copy";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { RunSubject, RunTargetChips } from "~/app/runs/run-work-summary";
import { cursorQueryOptions } from "~/integrations/tanstack-query/cursor-query-options";
import { activity } from "~/integrations/tanstack-query/generated/catalog.gen";
import { copyText } from "~/lib/clipboard";
import { formatInstant } from "~/lib/date-format";
import { formatCurrency } from "~/lib/utils";
import { Row, Stack } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/ui/primitives/card";
import { StatusText } from "~/ui/primitives/status-text";

// oxlint-disable-next-line complexity -- one selected record owns paired attempt and event pagination with their diagnostics.
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
              {run
                ? `${run.id} · ${run.recordType === "run" ? "Run" : "Image job"} · ${run.state} · ${formatInstant(run.createdAt, "dateTime")}`
                : id}
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
        {run?.error ? (
          <StatusText tone="destructive">{run.error}</StatusText>
        ) : null}
        {run ? (
          <p className="mt-3 text-xs text-muted-foreground">
            Cost:{" "}
            {run.estimatedCost === null
              ? "—"
              : formatCurrency(run.estimatedCost)}
            .{" "}
            {run.recordType === "image_job" && run.parentRunId
              ? "This job’s cost may already be included in its parent Run total."
              : "Cost shown for this record."}
          </p>
        ) : null}
        <Stack gap="sm">
          {run?.recordType === "image_job" ? (
            <section>
              <h3 className="font-medium">Attempts</h3>
              {attempts.map((attempt) => (
                <div
                  key={`${attempt.number}-${attempt.startedAt}`}
                  className="border-b border-border py-2 text-sm"
                >
                  <Row justify="between" gap="sm" wrap>
                    <span>
                      #{attempt.number} · {attempt.state} ·{" "}
                      {formatInstant(attempt.startedAt, "dateTime")}
                    </span>
                    <Row gap="xs">
                      {attempt.diagnosticsJson ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            void copyText(attempt.diagnosticsJson ?? "")
                          }
                        >
                          <CopyIcon />
                          Copy diagnostics
                        </Button>
                      ) : null}
                      {attempt.resultJson ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            void copyText(attempt.resultJson ?? "")
                          }
                        >
                          <CopyIcon />
                          Copy result
                        </Button>
                      ) : null}
                    </Row>
                  </Row>
                  {attempt.diagnosticsJson || attempt.resultJson ? (
                    <details className="mt-2">
                      <summary>Diagnostics and result</summary>
                      {attempt.diagnosticsJson ? (
                        <>
                          <h4 className="mt-2 font-medium">Diagnostics</h4>
                          <pre className="max-h-48 overflow-auto text-xs whitespace-pre-wrap">
                            {attempt.diagnosticsJson}
                          </pre>
                        </>
                      ) : null}
                      {attempt.resultJson ? (
                        <>
                          <h4 className="mt-2 font-medium">Result</h4>
                          <pre className="max-h-48 overflow-auto text-xs whitespace-pre-wrap">
                            {attempt.resultJson}
                          </pre>
                        </>
                      ) : null}
                    </details>
                  ) : (
                    <StatusText>
                      No historical diagnostics were recorded for this attempt.
                    </StatusText>
                  )}
                </div>
              ))}
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
            </section>
          ) : null}
          <section>
            <h3 className="font-medium">
              {run?.recordType === "run" ? "Operations and events" : "Events"}
            </h3>
            {eventRows.map((event) => (
              <div
                key={event.id}
                className="border-b border-border py-2 text-sm"
              >
                <Row justify="between" gap="sm" wrap>
                  <span>
                    {formatInstant(event.occurredAt, "dateTime")} ·{" "}
                    {event.source} · {event.event}
                  </span>
                  {event.detailsJson ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => void copyText(event.detailsJson ?? "")}
                    >
                      <CopyIcon />
                      Copy diagnostics
                    </Button>
                  ) : null}
                </Row>
                {event.detailsJson ? (
                  <details className="mt-2">
                    <summary>Diagnostics</summary>
                    <pre className="max-h-48 overflow-auto text-xs whitespace-pre-wrap">
                      {event.detailsJson}
                    </pre>
                  </details>
                ) : null}
              </div>
            ))}
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
          </section>
        </Stack>
      </CardContent>
    </Card>
  );
}

/** What the work is about, how far it got, and which records it touched. */
function RunWorkFacts({ run }: { run: ActivityRun }) {
  const outcome = run.targetSummary;
  return (
    <dl className="mb-3 grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 text-sm">
      <dt className="text-muted-foreground">Subject</dt>
      <dd className="min-w-0">
        <RunSubject run={run} />
      </dd>
      {run.currentStep ? (
        <>
          <dt className="text-muted-foreground">
            {run.active ? "Now" : "Last step"}
          </dt>
          <dd>{run.currentStep}</dd>
        </>
      ) : null}
      {outcome ? (
        <>
          <dt className="text-muted-foreground">Targets</dt>
          <dd className="grid gap-1">
            <span className="tabular-nums">{outcome}</span>
            <RunTargetChips run={run} wrap />
          </dd>
        </>
      ) : null}
      {run.recordType === "run" ? (
        <>
          <dt className="text-muted-foreground">Changed</dt>
          <dd className="tabular-nums">
            {run.changedCount === 1
              ? "1 record"
              : `${run.changedCount} records`}
          </dd>
        </>
      ) : null}
    </dl>
  );
}
