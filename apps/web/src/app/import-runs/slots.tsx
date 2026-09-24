import type { aiRunUsageInput } from "@cubby/schemas/ai";
import type { ImportRunOut } from "@cubby/schemas/import-run";
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
export function RunAiUsage({ record }: { record: ImportRunOut }) {
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
          <table className="w-full min-w-[72rem] text-left text-sm">
            <thead className="border-b border-border text-xs text-muted-foreground">
              <tr>
                <th className="p-2">Time</th>
                <th className="p-2">Operation</th>
                <th className="p-2">Model</th>
                <th className="p-2">Attempt</th>
                <th className="p-2">Tokens</th>
                <th className="p-2">Cache</th>
                <th className="p-2">Duration</th>
                <th className="p-2">Cost</th>
                <th className="p-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {usage.records.map((call) => (
                <tr
                  key={call.id}
                  className="border-b border-border last:border-0"
                >
                  <td className="p-2 font-mono text-xs">
                    {call.createdAt.toLocaleString()}
                  </td>
                  <td className="p-2">
                    <span>{call.operation}</span>
                    <span className="block text-xs text-muted-foreground">
                      {call.feature} · {call.provider}
                    </span>
                  </td>
                  <td className="p-2 font-mono text-xs">{call.model}</td>
                  <td className="p-2 font-mono text-xs tabular-nums">
                    {call.attempt}
                  </td>
                  <td className="p-2 font-mono text-xs tabular-nums">
                    {call.inputTokens ?? "—"} in / {call.outputTokens ?? "—"}{" "}
                    out
                  </td>
                  <td className="p-2 font-mono text-xs tabular-nums">
                    <span className="block">
                      {call.applicationCacheStatus === "hit"
                        ? "Application hit · no model call"
                        : `Application ${call.applicationCacheStatus ?? "—"}`}
                    </span>
                    <span className="block">
                      Gateway {call.cacheStatus ?? "—"}
                    </span>
                    <span className="block text-muted-foreground">
                      {call.cacheReadTokens ?? "—"} read /{" "}
                      {call.cacheWriteTokens ?? "—"} write
                    </span>
                  </td>
                  <td className="p-2 font-mono text-xs tabular-nums">
                    {formatDuration(call.durationMs)}
                  </td>
                  <td className="p-2 font-mono text-xs tabular-nums">
                    {call.estimatedCost == null
                      ? "unpriced"
                      : formatCurrency(call.estimatedCost, 6)}
                  </td>
                  <td className="p-2">
                    <Badge
                      variant={
                        call.status === "succeeded" ? "positive" : "destructive"
                      }
                    >
                      {call.status}
                    </Badge>
                    {call.gatewayLogId ? (
                      <span className="mt-1 block font-mono text-xs text-muted-foreground">
                        {call.gatewayLogId}
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
export function RunChanges({ record }: { record: ImportRunOut }) {
  return <AuditLogList runId={record.id} />;
}
