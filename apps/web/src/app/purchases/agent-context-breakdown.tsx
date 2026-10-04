import type { AgentConversationMessage } from "@cubby/schemas/agent-conversation";
import { useId, useMemo } from "react";

import {
  contextCallsFromMessages,
  summarizeContextCalls,
} from "~/lib/agent-context-breakdown";
import { formatCompactCount, formatCount } from "~/lib/utils";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/ui/primitives/table";

// Fixed sections first, then the largest tool results, then the grouped rest.
// Neighbouring segments never share a hue family.
const SEGMENT_COLORS = [
  "bg-chart-4",
  "bg-chart-3",
  "bg-chart-1",
  "bg-chart-8",
  "bg-chart-5",
  "bg-chart-6",
  "bg-chart-2",
  "bg-chart-7",
] as const;

/**
 * What filled each coordinator model call: one stacked bar per call, scaled
 * to its reported input tokens, with an equivalent table for exact values.
 */
export function AgentContextPerCall({
  messages,
}: {
  messages: readonly AgentConversationMessage[];
}) {
  const headingId = useId();
  const summary = useMemo(
    () => summarizeContextCalls(contextCallsFromMessages(messages)),
    [messages],
  );
  if (!summary.rows.length || summary.maxTokens === 0) return null;
  const { segments, rows, maxTokens, topContributors } = summary;
  const colorFor = (index: number) =>
    SEGMENT_COLORS[index % SEGMENT_COLORS.length];
  const anyCached = rows.some((row) => row.cachedTokens > 0);
  const anyEstimated = rows.some((row) => row.estimated);

  return (
    <section
      className="mt-3 border-t border-border pt-2"
      aria-labelledby={headingId}
    >
      <details>
        <summary
          id={headingId}
          className="min-h-11 cursor-pointer text-xs font-semibold md:min-h-0"
        >
          Context per call
        </summary>
        <div className="pt-1">
          {topContributors.length ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {`Top contributors across the run: ${topContributors
                .map(({ label, share }) => `${label} ${share}%`)
                .join(" · ")}`}
            </p>
          ) : null}
          <ul
            aria-label="Context categories"
            className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground"
          >
            {segments.map((segment, index) => (
              <li
                key={segment.key}
                className="flex min-w-0 items-center gap-1.5"
              >
                <span
                  aria-hidden="true"
                  className={`size-2 shrink-0 rounded-[2px] ${colorFor(index)}`}
                />
                {segment.label}
              </li>
            ))}
          </ul>
          <ul aria-label="Model calls" className="mt-2 space-y-1.5">
            {rows.map((row) => {
              const parts = segments
                .map((segment, index) => ({
                  ...segment,
                  color: colorFor(index),
                  tokens: row.values[segment.key] ?? 0,
                }))
                .filter((part) => part.tokens > 0);
              const label = `Call ${row.call}${row.estimated ? " (estimated)" : ""}: ${formatCount(row.inputTokens)} input tokens, ${formatCount(row.cachedTokens)} cached; ${parts
                .map((part) => `${part.label} ${formatCount(part.tokens)}`)
                .join(", ")}`;
              return (
                <li
                  key={row.call}
                  aria-label={label}
                  className="grid grid-cols-[3.25rem_minmax(0,1fr)_3.25rem] items-center gap-2 text-xs tabular-nums"
                >
                  <span aria-hidden="true" className="text-muted-foreground">
                    Call {row.call}
                  </span>
                  <div aria-hidden="true" className="min-w-0">
                    <div
                      className="flex h-3 overflow-hidden rounded-sm bg-muted"
                      style={{
                        width: `${(row.inputTokens / maxTokens) * 100}%`,
                      }}
                    >
                      {parts.map((part) => (
                        <div
                          key={part.key}
                          className={`h-full shrink-0 ${part.color}`}
                          style={{
                            width: `${(part.tokens / row.inputTokens) * 100}%`,
                          }}
                          title={`${part.label}: ${formatCount(part.tokens)} tokens (${Math.round((part.tokens / row.inputTokens) * 100)}%)`}
                        />
                      ))}
                    </div>
                    {row.cachedTokens > 0 ? (
                      <div
                        className="mt-0.5 h-0.5 rounded-full bg-foreground/45"
                        style={{
                          width: `${(row.cachedTokens / maxTokens) * 100}%`,
                        }}
                      />
                    ) : null}
                  </div>
                  <span aria-hidden="true" className="text-right">
                    {row.estimated ? "≈" : null}
                    {formatCompactCount(row.inputTokens, 1)}
                  </span>
                </li>
              );
            })}
          </ul>
          <div
            aria-hidden="true"
            className="mt-1 grid grid-cols-[3.25rem_minmax(0,1fr)_3.25rem] gap-2 text-[10px] leading-[14px] text-muted-foreground tabular-nums"
          >
            <span />
            <span className="flex justify-between border-t border-border pt-0.5">
              <span>0</span>
              <span>{formatCompactCount(maxTokens, 1)} input tokens</span>
            </span>
            <span />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {anyCached ? "The rule under a bar is the cached share. " : null}
            Sections are request sizes scaled to each call's reported input
            tokens
            {anyEstimated ? "; ≈ marks calls without reported usage" : null}.
          </p>
          <details className="mt-1 text-xs">
            <summary className="cursor-pointer text-muted-foreground">
              Show as table
            </summary>
            <Table
              aria-label="Context per call table"
              containerClassName="mt-1"
              className="table-auto tabular-nums"
            >
              <TableHeader>
                <TableRow>
                  <TableHead className="h-auto py-1 pr-2 pl-0">Call</TableHead>
                  <TableHead className="h-auto px-2 py-1 text-right">
                    Input
                  </TableHead>
                  <TableHead className="h-auto px-2 py-1 text-right">
                    Cached
                  </TableHead>
                  {segments.map((segment) => (
                    <TableHead
                      key={segment.key}
                      className="h-auto px-2 py-1 text-right"
                    >
                      {segment.label}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.call}>
                    <TableHead
                      scope="row"
                      className="h-auto py-1 pr-2 pl-0 text-foreground"
                    >
                      Call {row.call}
                      {row.estimated ? " (estimated)" : null}
                    </TableHead>
                    <TableCell className="px-2 py-1 text-right">
                      {formatCount(row.inputTokens)}
                    </TableCell>
                    <TableCell className="px-2 py-1 text-right">
                      {formatCount(row.cachedTokens)}
                    </TableCell>
                    {segments.map((segment) => (
                      <TableCell
                        key={segment.key}
                        className="px-2 py-1 text-right"
                      >
                        {formatCount(row.values[segment.key] ?? 0)}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </details>
        </div>
      </details>
    </section>
  );
}
