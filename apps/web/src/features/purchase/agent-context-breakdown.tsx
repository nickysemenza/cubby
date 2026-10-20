import type {
  AgentConversationMessage,
  AgentModelUsage,
} from "@cubby/schemas/agent-conversation";
import type { AiRunUsage } from "@cubby/schemas/ai";
import { agentUsageEvent } from "@cubby/schemas/purchase-agent-services";
import { useMemo } from "react";

import { formatCompactCount, formatCount } from "~/lib/number-format";
import { Disclosure } from "~/ui/layout/disclosure";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/ui/primitives/table";

import {
  contextCallsFromMessages,
  summarizeContextCalls,
} from "./agent-context-model";

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
      aria-label="Context per call"
    >
      <Disclosure summary="Context per call">
        <div>
          {topContributors.length ? (
            <p className="text-xs text-muted-foreground">
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
            className="mt-1 grid grid-cols-[3.25rem_minmax(0,1fr)_3.25rem] gap-2 text-2xs leading-[14px] text-muted-foreground tabular-nums"
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
          <Disclosure summary="Show as table" className="mt-1 text-xs">
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
          </Disclosure>
        </div>
      </Disclosure>
    </section>
  );
}

const TOKEN_COUNTERS = [
  ["inputTokens", "Input"],
  ["outputTokens", "Output"],
  ["cacheReadTokens", "Cache read"],
  ["cacheWriteTokens", "Cache write"],
] as const satisfies readonly (readonly [
  Exclude<keyof AgentModelUsage, "model">,
  string,
])[];

/**
 * The coordinator's tokens as Cubby's usage rows recorded them beside pi's
 * own `pi.usage` ledger. A difference names a model call one side missed,
 * such as a compaction summary; cost stays with the usage rows.
 */
export function AgentTokenAccounting({
  piUsage,
  recorded,
  settled,
}: {
  piUsage: readonly AgentModelUsage[] | undefined;
  recorded: AiRunUsage["tokensByModel"] | undefined;
  /** Whether usage was read after the Run ended, so a difference is real. */
  settled: boolean;
}) {
  const rows = useMemo(() => {
    if (!piUsage || !recorded) return [];
    const byModel = new Map<
      string,
      { pi?: AgentModelUsage; recorded?: AgentModelUsage }
    >();
    for (const usage of piUsage)
      byModel.set(usage.model, { ...byModel.get(usage.model), pi: usage });
    for (const row of recorded) {
      if (row.feature !== agentUsageEvent.shape.feature.value) continue;
      const model = `${row.provider}/${row.model}`;
      byModel.set(model, {
        ...byModel.get(model),
        recorded: { ...row, model },
      });
    }
    return [...byModel]
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([model, sides]) =>
        TOKEN_COUNTERS.map(([key, label]) => ({
          model,
          label,
          recorded: sides.recorded?.[key] ?? 0,
          pi: sides.pi?.[key] ?? 0,
        })).filter((row) => row.recorded > 0 || row.pi > 0),
      );
  }, [piUsage, recorded]);
  if (!rows.length) return null;
  const mismatched = rows.filter((row) => row.recorded !== row.pi);
  const flagged = settled && mismatched.length > 0;

  return (
    <section
      className="mt-3 border-t border-border pt-2"
      aria-label="Token accounting"
    >
      {/* Remounts so a difference that settles while mounted opens the body. */}
      <Disclosure
        key={flagged ? "flagged" : "quiet"}
        summary="Token accounting"
        defaultOpen={flagged}
      >
        <p
          className={`text-xs ${flagged ? "text-destructive" : "text-muted-foreground"}`}
        >
          {!mismatched.length
            ? "Cubby's usage records match pi's ledger."
            : flagged
              ? `${mismatched.length} ${mismatched.length === 1 ? "counter differs" : "counters differ"} between Cubby's usage records and pi's ledger.`
              : "Usage records may trail pi's ledger until the Run settles."}
        </p>
        <Table
          aria-label="Token accounting table"
          containerClassName="mt-1"
          className="table-auto text-xs tabular-nums"
        >
          <TableHeader>
            <TableRow>
              <TableHead className="h-auto py-1 pr-2 pl-0">Model</TableHead>
              <TableHead className="h-auto px-2 py-1">Tokens</TableHead>
              <TableHead className="h-auto px-2 py-1 text-right">
                Recorded
              </TableHead>
              <TableHead className="h-auto px-2 py-1 text-right">pi</TableHead>
              <TableHead className="h-auto px-2 py-1 text-right">
                Difference
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const difference = row.pi - row.recorded;
              return (
                <TableRow key={`${row.model}:${row.label}`}>
                  <TableHead
                    scope="row"
                    className="h-auto py-1 pr-2 pl-0 font-mono text-foreground"
                  >
                    {row.model}
                  </TableHead>
                  <TableCell className="px-2 py-1">{row.label}</TableCell>
                  <TableCell className="px-2 py-1 text-right">
                    {formatCount(row.recorded)}
                  </TableCell>
                  <TableCell className="px-2 py-1 text-right">
                    {formatCount(row.pi)}
                  </TableCell>
                  <TableCell
                    className={`px-2 py-1 text-right ${difference && settled ? "font-semibold text-destructive" : "text-muted-foreground"}`}
                  >
                    {difference > 0 ? "+" : null}
                    {formatCount(difference)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Disclosure>
    </section>
  );
}
