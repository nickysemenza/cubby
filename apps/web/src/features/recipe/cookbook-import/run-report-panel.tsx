import type { CookbookRunReport } from "@cubby/schemas/cookbook";
import { countLabel } from "@cubby/shared/pluralize";
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowCounterClockwise";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { WarningCircleIcon } from "@phosphor-icons/react/dist/csr/WarningCircle";
import { useMemo } from "react";

import { formatMinutesSeconds } from "~/lib/format-duration";
import { AiCost, formatAiCostSubtotal } from "~/ui/common/ai-cost";
import {
  RecordDetail,
  RecordDot,
  RecordList,
  RecordRow,
} from "~/ui/common/record-list";
import { Row, Stack } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/ui/primitives/collapsible";
import { Description } from "~/ui/primitives/description";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/ui/primitives/table";

import {
  type ChunkRow,
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
            `${countLabel(failedCount, "chunk")} failed — recipes in ${failedCount === 1 ? "it" : "them"} were lost`}
          {failedCount > 0 && troubled.length > failedCount && " · "}
          {troubled.length > failedCount &&
            `${troubled.length - failedCount} flagged`}
          {missing.length > 0 &&
            `${troubled.length > 0 ? " · " : ""}${countLabel(missing.length, "title")} in the contents were not found`}
        </Row>
        {canRetry && (
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            <ArrowCounterClockwiseIcon className="mr-1 size-3" />
            Retry extraction
          </Button>
        )}
      </Row>

      {troubled.length > 0 && (
        <RecordList aria-label="Troubled chunks">
          {troubled.map((chunk) => (
            <ChunkRecord key={chunk.id} chunk={chunk} />
          ))}
        </RecordList>
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

/** One troubled chunk: its outcome as the mark, where it sits and how it ran, and why. */
function ChunkRecord({ chunk }: { chunk: ChunkRow }) {
  const failed = chunk.status === "failed";
  const facts = [
    ...(chunk.start !== undefined && chunk.end !== undefined
      ? [
          <span key="lines">
            lines {chunk.start}–{chunk.end}
          </span>,
        ]
      : []),
    ...(chunk.final_model
      ? [
          <code key="model" className="font-mono text-2xs">
            {chunk.final_model}
          </code>,
        ]
      : []),
    ...(chunk.attempts !== undefined
      ? [<span key="attempts">{countLabel(chunk.attempts, "attempt")}</span>]
      : []),
  ];
  // A flag's tag is shown inline; anything else the crate wrote on it is kept as raw evidence.
  const diagnostics = chunk.flags.filter(
    (flag) => Object.keys(flag).length > 1,
  );
  return (
    <RecordRow
      leading={
        <RecordDot
          state={
            failed ? "failed" : chunk.flags.length > 0 ? "warning" : "done"
          }
          label={
            failed ? "Failed" : chunk.flags.length > 0 ? "Flagged" : "Done"
          }
        />
      }
      primary={<code className="font-mono text-xs">{chunk.id}</code>}
      clip={false}
      secondary={
        <span className="grid gap-0.5">
          {facts.length > 0 ? (
            <span>
              {facts.map((fact, index) => (
                <span key={fact.key}>
                  {index > 0 ? " · " : null}
                  {fact}
                </span>
              ))}
            </span>
          ) : null}
          {chunk.flags.length > 0 ? (
            <span className="flex flex-wrap gap-x-2 text-warning-ink">
              {[...new Set(chunk.flags.map((flag) => flag.flag))].map(
                (flag) => (
                  <code key={flag} className="font-mono text-2xs">
                    {flag}
                  </code>
                ),
              )}
            </span>
          ) : null}
          {failed ? (
            <span className="break-words text-destructive">
              Failed — the recipes in this chunk were lost.
            </span>
          ) : null}
        </span>
      }
      detail={
        diagnostics.length > 0 ? (
          <RecordDetail summary="Flag details">
            <pre className="max-h-60 overflow-auto bg-muted/30 p-2 font-mono text-2xs break-words whitespace-pre-wrap">
              {JSON.stringify(diagnostics, null, 2)}
            </pre>
          </RecordDetail>
        ) : null
      }
    />
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
        Run report —{" "}
        {formatAiCostSubtotal(
          report.chargedCost,
          report.chargedUnpricedCount,
          report.count,
          report.chargedComplete,
        )}{" "}
        charged · {formatMinutesSeconds(report.wall_ms)} ·{" "}
        {countLabel(calls.length, "call")}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <Stack gap="sm" className="mt-2 border border-border p-2">
          <Description size="xs">
            {report.crosscheck.matched}/{report.crosscheck.nav_titles} contents
            titles matched
            {recall != null && ` · recall ${(recall * 100).toFixed(0)}%`}
            {report.incomplete && " · incomplete"}
            {report.cancelled && " · cancelled"}
            {(report.chargedUnpricedCount > 0 ||
              report.chargedComplete === false) &&
              " · charge subtotal incomplete"}
          </Description>

          <AiCost cost={report} />
          <Description size="xs">
            {report.comparedCalls > 0
              ? formatAiCostSubtotal(report.savings, 0)
              : "Unavailable"}{" "}
            savings · {report.comparedCalls} of {report.count} calls compared
          </Description>
          {report.usage_by_model.length > 0 && (
            <ul className="space-y-0.5 text-2xs text-muted-foreground">
              {report.usage_by_model.map((usage) => (
                <li key={usage.model}>
                  <span className="font-mono">{usage.model}</span> ·{" "}
                  {countLabel(usage.calls, "call")}
                  <AiCost cost={usage} />
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
              {countLabel(unresolved.length, "unresolved reference")}:{" "}
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
                    <TableHead className="text-right">
                      Charged / standard
                    </TableHead>
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
                        <AiCost cost={call} />
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
