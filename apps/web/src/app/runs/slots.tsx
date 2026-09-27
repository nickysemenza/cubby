import type { aiRunUsageInput } from "@cubby/schemas/ai";
import type { RunOut } from "@cubby/schemas/run";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { z } from "zod";

import { AuditLogList } from "~/app/_components/audit-log/audit-log-list";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { StatusText } from "~/components/ui/status-text";
import { run } from "~/entities/run.functions";
import { formatDuration } from "~/lib/format-duration";
import { formatCurrency } from "~/lib/utils";

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
