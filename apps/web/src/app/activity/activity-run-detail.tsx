import { useInfiniteQuery } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import { useEffect, useMemo } from "react";
import { z } from "zod";

import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { StatusText } from "~/components/ui/status-text";
import { activity } from "~/lib/activity.functions";
import { copyText } from "~/lib/clipboard";

const moment = (value: string) => new Date(value).toLocaleString();

export function ActivityRunDetail({
  id,
  onClose,
}: {
  id: string;
  onClose: () => void;
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
    <Card className="mt-4 max-w-4xl">
      <CardHeader>
        <Row justify="between" align="start" gap="sm" wrap>
          <div>
            <CardTitle>{run?.subjectName ?? "Activity run"}</CardTitle>
            <CardDescription>
              {run
                ? `${run.kind.replaceAll("_", " ")} · ${run.state} · ${moment(run.createdAt)}`
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
          {id.startsWith("PIR-") ? (
            <a
              className="text-primary hover:underline"
              href={`/purchase-imports/${id}`}
            >
              Open purchase run details
            </a>
          ) : null}
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
        <Stack gap="sm">
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
                    {moment(attempt.startedAt)}
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
                        <Copy />
                        Copy diagnostics
                      </Button>
                    ) : null}
                    {attempt.resultJson ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => void copyText(attempt.resultJson ?? "")}
                      >
                        <Copy />
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
          <section>
            <h3 className="font-medium">Events</h3>
            {eventRows.map((event) => (
              <Row
                key={event.id}
                justify="between"
                gap="sm"
                wrap
                className="border-b border-border py-2 text-sm"
              >
                <span>
                  {moment(event.occurredAt)} · {event.source} · {event.event}
                </span>
                {event.detailsJson ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => void copyText(event.detailsJson ?? "")}
                  >
                    <Copy />
                    Copy diagnostics
                  </Button>
                ) : null}
              </Row>
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
