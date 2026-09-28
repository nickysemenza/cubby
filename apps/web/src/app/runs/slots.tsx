import type { aiRunUsageInput } from "@cubby/schemas/ai";
import type { RunOut } from "@cubby/schemas/run";
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { z } from "zod";

import { AuditLogList } from "~/app/_components/audit-log/audit-log-list";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { StatusText } from "~/components/ui/status-text";
import { run } from "~/entities/run.functions";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import { formatDuration } from "~/lib/format-duration";
import { formatCurrency } from "~/lib/utils";

const phaseLabel = (phase: string) =>
  phase.replaceAll("_", " ").replace(/^./u, (letter) => letter.toUpperCase());

/** Durable progress for every Run, including work completed outside this tab. */
// oxlint-disable-next-line eslint/complexity -- This shared slot renders status, optional job inputs, and durable events together.
export function RunLiveProgress({ record }: { record: RunOut }) {
  const client = useQueryClient();
  const progressQuery = useQuery({
    ...run.liveProgress.queryOptions({ shortcode: record.id }),
    refetchInterval: (query) => {
      const status = query.state.data?.status ?? record.status;
      return status === "running" ? 1_000 : false;
    },
  });
  const progress = progressQuery.data;
  useEffect(() => {
    if (progress && progress.status !== record.status)
      void invalidateOperationTags(client, ripple.runOnly);
  }, [client, progress, record.id, record.status]);
  if (progressQuery.isLoading)
    return <StatusText>Loading Run progress…</StatusText>;
  if (progressQuery.isError)
    return (
      <StatusText tone="destructive">{progressQuery.error.message}</StatusText>
    );
  if (!progress) return <StatusText>Run progress is unavailable.</StatusText>;
  const active = progress.status === "running";
  const last = progress.progress.at(-1);

  return (
    <div className="grid gap-3" aria-live="polite" aria-atomic="false">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
        <strong className="font-medium">
          {active
            ? (last?.detail ?? "Working…")
            : progress.status === "completed"
              ? "Run completed"
              : progress.status === "failed"
                ? "Run failed"
                : phaseLabel(progress.status)}
        </strong>
        {active ? (
          <span className="text-muted-foreground">Updating live</span>
        ) : null}
      </div>
      {progress.gmail ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm tabular-nums">
          <span>
            {progress.gmail.pagesScanned}{" "}
            {progress.gmail.pagesScanned === 1 ? "page" : "pages"} scanned
          </span>
          <span>
            {progress.gmail.searched} messages{" "}
            {progress.status === "completed" ? "checked" : "found"}
          </span>
          <span>{progress.gmail.skipped} already saved</span>
          <span>
            {progress.gmail.reviewable} order{" "}
            {progress.gmail.reviewable === 1 ? "email" : "emails"} to review
          </span>
          {progress.gmail.hasMorePages && active ? (
            <span>Continuing to older messages</span>
          ) : null}
        </div>
      ) : null}
      {progress.gmail ? (
        <section
          aria-label="Search inputs"
          className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm"
        >
          <h3 className="font-medium">Search inputs</h3>
          <dl className="mt-1 grid gap-x-4 gap-y-1 sm:grid-cols-[max-content_1fr]">
            <dt className="text-muted-foreground">Date range</dt>
            <dd>
              {progress.gmail.after === "1970/01/01"
                ? "All available mail"
                : `Since ${progress.gmail.after.replaceAll("/", "-")}`}
            </dd>
            <dt className="text-muted-foreground">Sender search</dt>
            <dd className="min-w-0 break-words">
              {progress.gmail.searchTerms.length
                ? progress.gmail.searchTerms.join(", ")
                : "Criteria were not saved for this earlier Run"}
            </dd>
            <dt className="text-muted-foreground">Starting point</dt>
            <dd>
              {progress.gmail.startedFromOlderPage
                ? "Older Gmail page"
                : "Newest matching email"}
            </dd>
          </dl>
        </section>
      ) : null}
      {progress.gmail?.error ? (
        <StatusText tone="destructive">{progress.gmail.error}</StatusText>
      ) : null}
      {progress.progress.length > 0 ? (
        <ol className="grid gap-0 border-t border-border text-sm">
          {progress.progress.map((event) => (
            <li
              key={event.id}
              className="flex flex-wrap gap-x-3 gap-y-1 border-b border-border py-2"
            >
              <time
                className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums"
                dateTime={event.createdAt}
              >
                {new Date(event.createdAt).toLocaleTimeString()}
              </time>
              <span className="font-medium">{phaseLabel(event.phase)}</span>
              {event.detail ? (
                <span className="min-w-0 break-words text-muted-foreground">
                  {event.detail}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      ) : (
        <StatusText>
          {active
            ? "Waiting for the first progress update…"
            : "No progress updates were recorded for this Run."}
        </StatusText>
      )}
    </div>
  );
}

/** Run detail slot: every AI call the run grouped, for any run purpose. */
export function RunAiUsage({ record }: { record: RunOut }) {
  // Each entry is the cursor that loaded that page; `null` is the first.
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const cursor = cursors.at(-1) ?? null;
  const input: z.input<typeof aiRunUsageInput> = { runId: record.id };
  if (cursor !== null) input.cursor = cursor;
  const usageQuery = useQuery({
    ...run.aiUsage.queryOptions(input),
    placeholderData: keepPreviousData,
    refetchInterval:
      record.status === "running" || record.status.startsWith("paused")
        ? 3_000
        : false,
  });
  if (usageQuery.isLoading) return <StatusText>Loading AI usage…</StatusText>;
  if (usageQuery.isError)
    return (
      <StatusText tone="destructive">{usageQuery.error.message}</StatusText>
    );
  const usage = usageQuery.data;
  if (!usage) return null;
  const loading = usageQuery.isFetching;
  const nextCursor = usage.nextCursor;

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-sm text-muted-foreground tabular-nums">
          {usage.unpricedCount > 0 ? "Estimated subtotal" : "Subtotal"}{" "}
          {formatCurrency(usage.pricedSubtotal, 6)}
          {usage.unpricedCount > 0 ? ` · ${usage.unpricedCount} unpriced` : ""}
        </p>
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={cursors.length <= 1 || loading}
            onClick={() => setCursors((history) => history.slice(0, -1))}
          >
            Previous
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={nextCursor === null || loading}
            onClick={() => {
              if (nextCursor !== null)
                setCursors((history) => [...history, nextCursor]);
            }}
          >
            Next
          </Button>
        </div>
      </div>
      {usage.records.length ? (
        <div className="overflow-x-auto">
          <table className="w-max min-w-full table-auto text-left text-[13px] leading-5 whitespace-nowrap tabular-nums [&_td]:px-2 [&_td]:py-1 [&_th]:px-2 [&_th]:py-1 [&_tr]:h-8">
            <thead className="border-b border-border text-xs text-muted-foreground">
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Operation</th>
                <th scope="col">Model</th>
                <th scope="col">Attempt</th>
                <th scope="col">Tokens</th>
                <th scope="col">Cache</th>
                <th scope="col">Duration</th>
                <th scope="col">Cost</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {usage.records.map((call) => (
                <tr
                  key={call.id}
                  className="border-b border-border last:border-0"
                >
                  <td className="font-mono">
                    {call.createdAt.toLocaleString()}
                  </td>
                  <td>
                    {call.operation}
                    <span className="text-muted-foreground">
                      {" "}
                      · {call.feature} · {call.provider}
                    </span>
                  </td>
                  <td className="font-mono">{call.model}</td>
                  <td className="font-mono">{call.attempt}</td>
                  <td className="font-mono">
                    {call.inputTokens ?? "—"} in / {call.outputTokens ?? "—"}{" "}
                    out
                  </td>
                  <td className="font-mono">
                    {call.applicationCacheStatus === "hit"
                      ? "Application hit · no model call"
                      : `Application ${call.applicationCacheStatus ?? "—"}`}
                    {" · Gateway "}
                    {call.cacheStatus ?? "—"}
                    <span className="text-muted-foreground">
                      {" · "}
                      {call.cacheReadTokens ?? "—"} read /{" "}
                      {call.cacheWriteTokens ?? "—"} write
                    </span>
                  </td>
                  <td className="font-mono">
                    {formatDuration(call.durationMs)}
                  </td>
                  <td className="font-mono">
                    {call.estimatedCost == null
                      ? "unpriced"
                      : formatCurrency(call.estimatedCost, 6)}
                  </td>
                  <td>
                    <Badge
                      variant={
                        call.status === "succeeded" ? "positive" : "destructive"
                      }
                    >
                      {call.status}
                    </Badge>
                    {call.gatewayLogId ? (
                      <span className="ml-1 font-mono text-muted-foreground">
                        · {call.gatewayLogId}
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <StatusText>No AI calls were recorded for this run.</StatusText>
      )}
    </div>
  );
}

/** Run detail slot: every audit entry the run wrote. */
export function RunChanges({ record }: { record: RunOut }) {
  return <AuditLogList runId={record.id} />;
}
