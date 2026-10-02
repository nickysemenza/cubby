import { CopyIcon } from "@phosphor-icons/react/dist/csr/Copy";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { z } from "zod";

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
    activity.detail.infiniteQueryOptions(
      { id, limit: 20 },
      {
        pageParamSchema: z.nullable(z.string()),
        initialPageParam: null,
        page: (input, cursor) => {
          const next = { ...input };
          if (cursor !== null) next.cursor = cursor;
          return next;
        },
        getNextPageParam: (page) => page.nextAttemptCursor ?? undefined,
      },
    ),
  );
  const events = useInfiniteQuery(
    activity.events.infiniteQueryOptions(
      { id, limit: 20 },
      {
        pageParamSchema: z.nullable(z.string()),
        initialPageParam: null,
        page: (input, cursor) => {
          const next = { ...input };
          if (cursor !== null) next.cursor = cursor;
          return next;
        },
        getNextPageParam: (page) => page.nextCursor ?? undefined,
      },
    ),
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
            <CardTitle>{run?.subjectName ?? "Work detail"}</CardTitle>
            <CardDescription>
              {run
                ? `${run.id} · ${run.recordType === "run" ? "Run" : "Image job"} · ${run.kind.replaceAll("_", " ")} · ${run.state} · ${formatInstant(run.createdAt, "dateTime")}`
                : id}
            </CardDescription>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            Close
          </Button>
        </Row>
      </CardHeader>
      <CardContent>
        <Row gap="sm" wrap>
          {run?.subjectHref ? (
            <a className="text-primary hover:underline" href={run.subjectHref}>
              Open subject
            </a>
          ) : null}
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
