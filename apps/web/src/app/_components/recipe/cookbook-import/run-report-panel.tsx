import type { CookbookRunReport } from "@cubby/schemas/cookbook";
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowCounterClockwise";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { WarningCircleIcon } from "@phosphor-icons/react/dist/csr/WarningCircle";
import { useMemo } from "react";

import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/components/ui/collapsible";
import { Description } from "~/components/ui/description";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";

import { formatDuration, formatUsd } from "./import-helpers";
import {
  flagSummary,
  reportCalls,
  reportEscalation,
  reportUnresolvedRefs,
  troubledChunks,
} from "./run-report-view";

/**
 * Where a run fell short, and what to do about it.
 *
 * Two different kinds of trouble share this panel because they share a remedy.
 * A chunk with `status: "failed"` lost its recipes outright; a chunk with flags
 * kept its recipes but the crate is not confident in them (a low amount-parse
 * rate, a truncated response, a title it read as a caption). Separately, the
 * cross-check names titles the table of contents promised and the text never
 * produced. All three are silent in the tree itself — the tree only shows what
 * was found — so they are surfaced here or not at all.
 */
export function FailuresPanel({
  report,
  onRetry,
  canRetry,
}: {
  report: CookbookRunReport;
  onRetry: () => void;
  canRetry: boolean;
}) {
  const troubled = useMemo(() => troubledChunks(report), [report]);
  const missing = report.crosscheck.missing;
  if (troubled.length === 0 && missing.length === 0 && !report.incomplete) {
    return null;
  }
  const failedCount = troubled.filter(
    (chunk) => chunk.status === "failed",
  ).length;

  return (
    <Stack gap="sm" className="border border-warning/40 bg-warning/5 p-2">
      <Row align="center" justify="between" gap="sm" wrap>
        <Row
          as="span"
          align="center"
          gap="xs"
          className="text-xs text-warning-ink"
        >
          <WarningCircleIcon className="size-3 shrink-0" />
          {failedCount > 0 &&
            `${failedCount} chunk${failedCount === 1 ? "" : "s"} failed — recipes in ${failedCount === 1 ? "it" : "them"} were lost`}
          {failedCount > 0 && troubled.length > failedCount && " · "}
          {troubled.length > failedCount &&
            `${troubled.length - failedCount} flagged`}
          {missing.length > 0 &&
            `${troubled.length > 0 ? " · " : ""}${missing.length} title${missing.length === 1 ? "" : "s"} in the contents were not found`}
        </Row>
        {canRetry && (
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            <ArrowCounterClockwiseIcon className="mr-1 size-3" />
            Retry extraction
          </Button>
        )}
      </Row>

      {troubled.length > 0 && (
        <ul className="space-y-1">
          {troubled.map((chunk) => (
            <li
              key={chunk.id}
              className="font-mono text-2xs text-muted-foreground"
              title={flagSummary(chunk)}
            >
              {chunk.id}
              {chunk.start !== undefined && chunk.end !== undefined
                ? ` · lines ${chunk.start}–${chunk.end}`
                : ""}
              {chunk.final_model ? ` · ${chunk.final_model}` : ""}
              {chunk.attempts !== undefined
                ? ` · ${chunk.attempts} attempt${chunk.attempts === 1 ? "" : "s"}`
                : ""}
              {chunk.flags.length > 0 ? ` · ${flagSummary(chunk)}` : ""}
              {chunk.status === "failed" ? " · failed" : ""}
            </li>
          ))}
        </ul>
      )}

      {missing.length > 0 && (
        <Description size="xs">
          Not found: {missing.slice(0, 12).join(", ")}
          {missing.length > 12 ? `, +${missing.length - 12} more` : ""}
        </Description>
      )}
    </Stack>
  );
}

/** The whole run, folded away: cost by model, timings, and every call made. */
export function RunReportPanel({ report }: { report: CookbookRunReport }) {
  const calls = useMemo(() => reportCalls(report), [report]);
  const escalation = useMemo(() => reportEscalation(report), [report]);
  const unresolved = useMemo(() => reportUnresolvedRefs(report), [report]);
  const recall = report.crosscheck.recall;

  return (
    <Collapsible>
      <CollapsibleTrigger className="flex w-full items-center gap-1 text-left text-xs text-muted-foreground hover:text-foreground">
        <CaretDownIcon className="size-3" />
        Run report — {formatUsd(report.total_cost_usd)}
        {!report.cost_complete && "+"} · {formatDuration(report.wall_ms)} ·{" "}
        {calls.length} call{calls.length === 1 ? "" : "s"}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <Stack gap="sm" className="mt-2 border border-border p-2">
          <Description size="xs">
            {report.crosscheck.matched}/{report.crosscheck.nav_titles} contents
            titles matched
            {recall != null && ` · recall ${(recall * 100).toFixed(0)}%`}
            {report.incomplete && " · incomplete"}
            {report.cancelled && " · cancelled"}
            {!report.cost_complete &&
              " · cost incomplete (an unpriced model was used)"}
          </Description>

          {report.usage_by_model.length > 0 && (
            <ul className="space-y-0.5 text-2xs text-muted-foreground">
              {report.usage_by_model.map((usage) => (
                <li key={usage.model}>
                  <span className="font-mono">{usage.model}</span> ·{" "}
                  {usage.calls} call{usage.calls === 1 ? "" : "s"}
                  {usage.cost_usd != null && ` · ${formatUsd(usage.cost_usd)}`}
                </li>
              ))}
            </ul>
          )}

          {escalation && (
            <Description size="xs">
              Escalated {escalation.from_model} → {escalation.to_model}:{" "}
              {escalation.reason}
              {escalation.flagged_fraction != null &&
                ` (${(escalation.flagged_fraction * 100).toFixed(0)}% flagged)`}
            </Description>
          )}

          {unresolved.length > 0 && (
            <Description size="xs">
              {unresolved.length} unresolved reference
              {unresolved.length === 1 ? "" : "s"}:{" "}
              {unresolved
                .slice(0, 8)
                .map((ref) => ref.text)
                .join(", ")}
              {unresolved.length > 8 ? `, +${unresolved.length - 8} more` : ""}
            </Description>
          )}

          {calls.length > 0 && (
            <div className="max-h-64 overflow-auto">
              <Table className="table-auto">
                <TableHeader>
                  <TableRow>
                    <TableHead>Model</TableHead>
                    <TableHead>Purpose</TableHead>
                    <TableHead>Chunk</TableHead>
                    <TableHead className="text-right">Latency</TableHead>
                    <TableHead className="text-right">Status</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                    <TableHead>Outcome</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {calls.map((call, index) => (
                    <TableRow key={`${call.chunk_id}:${call.seq ?? index}`}>
                      <TableCell className="font-mono text-2xs">
                        {call.model}
                      </TableCell>
                      <TableCell className="text-2xs">
                        {call.purpose ?? ""}
                        {call.attempt !== undefined && call.attempt > 1
                          ? ` #${call.attempt}`
                          : ""}
                      </TableCell>
                      <TableCell className="font-mono text-2xs">
                        {call.chunk_id}
                      </TableCell>
                      <TableCell className="text-right text-2xs tabular-nums">
                        {call.cached
                          ? "cached"
                          : call.latency_ms !== undefined
                            ? `${Math.round(call.latency_ms)}ms`
                            : ""}
                      </TableCell>
                      <TableCell className="text-right text-2xs tabular-nums">
                        {call.status ?? ""}
                      </TableCell>
                      <TableCell className="text-right text-2xs tabular-nums">
                        {call.cost_usd != null ? formatUsd(call.cost_usd) : "—"}
                      </TableCell>
                      <TableCell className="text-2xs">
                        {call.outcome?.outcome ?? ""}
                        {call.truncated ? " · truncated" : ""}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </Stack>
      </CollapsibleContent>
    </Collapsible>
  );
}
