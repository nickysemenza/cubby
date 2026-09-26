import type { FlueConversationMessage } from "@flue/sdk";
import { useId, useMemo } from "react";

import {
  contextCallsFromMessages,
  summarizeContextCalls,
} from "~/lib/agent-context-breakdown";

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

const exact = new Intl.NumberFormat();
const compact = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

/**
 * What filled each coordinator model call: one stacked bar per call, scaled
 * to its reported input tokens, with an equivalent table for exact values.
 */
export function AgentContextPerCall({
  messages,
}: {
  messages: readonly FlueConversationMessage[];
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
      <h4 id={headingId} className="text-xs font-semibold">
        Context per call
      </h4>
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
          <li key={segment.key} className="flex min-w-0 items-center gap-1.5">
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
          const label = `Call ${row.call}${row.estimated ? " (estimated)" : ""}: ${exact.format(row.inputTokens)} input tokens, ${exact.format(row.cachedTokens)} cached; ${parts
            .map((part) => `${part.label} ${exact.format(part.tokens)}`)
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
                  style={{ width: `${(row.inputTokens / maxTokens) * 100}%` }}
                >
                  {parts.map((part) => (
                    <div
                      key={part.key}
                      className={`h-full shrink-0 ${part.color}`}
                      style={{
                        width: `${(part.tokens / row.inputTokens) * 100}%`,
                      }}
                      title={`${part.label}: ${exact.format(part.tokens)} tokens (${Math.round((part.tokens / row.inputTokens) * 100)}%)`}
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
                {compact.format(row.inputTokens)}
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
          <span>{compact.format(maxTokens)} input tokens</span>
        </span>
        <span />
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {anyCached ? "The rule under a bar is the cached share. " : null}
        Sections are request sizes scaled to each call's reported input tokens
        {anyEstimated ? "; ≈ marks calls without reported usage" : null}.
      </p>
      <details className="mt-1 text-xs">
        <summary className="cursor-pointer text-muted-foreground">
          Show as table
        </summary>
        <div className="mt-1 overflow-x-auto">
          <table
            aria-label="Context per call table"
            className="w-full border-collapse text-xs tabular-nums"
          >
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th scope="col" className="py-1 pr-2 font-medium">
                  Call
                </th>
                <th scope="col" className="px-2 py-1 text-right font-medium">
                  Input
                </th>
                <th scope="col" className="px-2 py-1 text-right font-medium">
                  Cached
                </th>
                {segments.map((segment) => (
                  <th
                    key={segment.key}
                    scope="col"
                    className="px-2 py-1 text-right font-medium whitespace-nowrap"
                  >
                    {segment.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.call}
                  className="border-b border-border/70 last:border-0"
                >
                  <th
                    scope="row"
                    className="py-1 pr-2 text-left font-medium whitespace-nowrap"
                  >
                    Call {row.call}
                    {row.estimated ? " (estimated)" : null}
                  </th>
                  <td className="px-2 py-1 text-right">
                    {exact.format(row.inputTokens)}
                  </td>
                  <td className="px-2 py-1 text-right">
                    {exact.format(row.cachedTokens)}
                  </td>
                  {segments.map((segment) => (
                    <td key={segment.key} className="px-2 py-1 text-right">
                      {exact.format(row.values[segment.key] ?? 0)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
