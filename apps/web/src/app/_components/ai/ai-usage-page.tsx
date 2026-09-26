import type { AiUsageEntry, AiUsageSummaryRow } from "@cubby/schemas/ai";
import { parseShortcode } from "@cubby/shared";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { EntityInlineLinkById } from "~/app/_components/EntityInlineLinkById";
import { ErrorDisplay } from "~/components/feedback/error-display";
import { Grid, Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { useHydrated } from "~/hooks/useHydrated";
import { ai } from "~/lib/ai.functions";
import { formatCount, formatCurrency } from "~/lib/utils";

const supportedEntityTypes = [
  "product",
  "location",
  "recipe",
  "ingredient",
  "inventory",
] as const;

type SupportedEntityType = (typeof supportedEntityTypes)[number];

interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  knownCost: number;
  unpricedCalls: number;
  durationMs: number;
}

function isSupportedEntityType(
  value: string | null,
): value is SupportedEntityType {
  return supportedEntityTypes.some((entityType) => entityType === value);
}

function formatTokens(value: number | null | undefined): string {
  return formatCount(value ?? 0);
}

function formatUsd(value: number | null | undefined): string {
  return value == null
    ? "unpriced"
    : formatCurrency(value, 6, { minimumFractionDigits: 4 });
}

function formatMs(value: number): string {
  if (value < 1000) return `${value}ms`;
  return `${(value / 1000).toFixed(1)}s`;
}

function usageTotals(rows: AiUsageSummaryRow[]): UsageTotals {
  return rows.reduce<UsageTotals>(
    (totals, row) => ({
      calls: totals.calls + row.count,
      inputTokens: totals.inputTokens + row.inputTokens,
      outputTokens: totals.outputTokens + row.outputTokens,
      knownCost: totals.knownCost + (row.estimatedCost ?? 0),
      unpricedCalls:
        totals.unpricedCalls + (row.estimatedCost == null ? row.count : 0),
      durationMs: totals.durationMs + row.durationMs,
    }),
    {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      knownCost: 0,
      unpricedCalls: 0,
      durationMs: 0,
    },
  );
}

function UsageMetric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="border border-border bg-card p-4">
      <div className="font-mono text-xs tracking-wide text-muted-foreground uppercase">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
      {detail ? (
        <div className="text-xs text-muted-foreground">{detail}</div>
      ) : null}
    </div>
  );
}

export function AiUsageTableStatus({
  isLoading,
  error,
  isEmpty,
  emptyLabel,
  retryLabel,
  onRetry,
  colSpan = 11,
}: {
  isLoading: boolean;
  error: unknown;
  isEmpty: boolean;
  emptyLabel: string;
  retryLabel: string;
  onRetry: () => void;
  colSpan?: number;
}) {
  if (!isLoading && !error && !isEmpty) return null;

  return (
    <TableRow>
      <TableCell colSpan={colSpan}>
        {isLoading ? (
          <Spinner />
        ) : error ? (
          <Stack gap="sm" className="items-start py-2">
            <ErrorDisplay error={error} title="AI usage data" />
            <Button type="button" variant="outline" onClick={onRetry}>
              {retryLabel}
            </Button>
          </Stack>
        ) : (
          <span className="text-muted-foreground">{emptyLabel}</span>
        )}
      </TableCell>
    </TableRow>
  );
}

/** Exported for the UUID-boundary regression test; not part of the page's public surface. */
export function UsageEntityLink({
  row,
}: {
  row: Pick<AiUsageEntry, "entityKind" | "entityId">;
}) {
  if (!row.entityKind || !row.entityId) {
    return <span className="text-muted-foreground">-</span>;
  }
  if (!isSupportedEntityType(row.entityKind)) {
    return <span className="text-muted-foreground">{row.entityKind}</span>;
  }

  // AiUsage.entityId is recorded from queue/side-effect payloads that carry
  // private uuids, while EntityInlineLinkById expects a public shortcode.
  // Never send a uuid into that boundary.
  if (parseShortcode(row.entityId)?.type !== row.entityKind) {
    return (
      <span className="text-muted-foreground">
        {row.entityKind} · {row.entityId.slice(0, 8)}
      </span>
    );
  }

  return (
    <EntityInlineLinkById
      entityType={row.entityKind}
      entityId={row.entityId}
      compact
    />
  );
}

function CostCell({ value }: { value: number | null }) {
  return (
    <span className={value == null ? "text-muted-foreground" : undefined}>
      {formatUsd(value)}
    </span>
  );
}

export function AiUsagePage() {
  const [days, setDays] = useState(7);
  const [recentLimit, setRecentLimit] = useState(50);
  const summaryQuery = useQuery(ai.usageSummary.queryOptions({ days }));
  const recentQuery = useQuery(
    ai.usageRecent.queryOptions({ limit: recentLimit }),
  );
  // Hydration-stable. Whether a query's data has landed differs between the SSR
  // render and the first client render — TanStack Start's query stream races
  // React's hydration and can win in either direction (here the SERVER rendered
  // rows the client's first render did not have). Gating both sides on
  // `hydrated` makes the two renders identical whatever either cache holds; the
  // real rows appear on the render right after hydration. See useHydratedLoading.
  const hydrated = useHydrated();
  const summaryError = hydrated ? summaryQuery.error : null;
  const summaryRows = hydrated && !summaryError ? summaryQuery.data : undefined;
  const summaryLoading = !hydrated || summaryQuery.isLoading;
  const recentError = hydrated ? recentQuery.error : null;
  const recentRows = hydrated && !recentError ? recentQuery.data : undefined;
  const recentLoading = !hydrated || recentQuery.isLoading;

  const totals = useMemo(() => usageTotals(summaryRows ?? []), [summaryRows]);

  return (
    <Stack gap="md">
      <Row justify="between" align="center" gap="sm" wrap>
        <Row gap="sm" wrap>
          {[7, 30, 90].map((value) => (
            <Button
              key={value}
              type="button"
              variant={days === value ? "secondary" : "outline"}
              onClick={() => setDays(value)}
            >
              {value}d
            </Button>
          ))}
        </Row>
        <Row gap="sm" align="center" wrap>
          <span className="text-sm text-muted-foreground">Recent calls</span>
          {[25, 50, 100, 200].map((value) => (
            <Button
              key={value}
              type="button"
              variant={recentLimit === value ? "secondary" : "outline"}
              onClick={() => setRecentLimit(value)}
            >
              {value}
            </Button>
          ))}
        </Row>
      </Row>

      {!summaryError ? (
        <Grid cols="summary">
          <UsageMetric label="Calls" value={formatTokens(totals.calls)} />
          <UsageMetric
            label="Tokens"
            value={formatTokens(totals.inputTokens + totals.outputTokens)}
            detail={`${formatTokens(totals.inputTokens)} in / ${formatTokens(
              totals.outputTokens,
            )} out`}
          />
          <UsageMetric
            label="USD cost"
            value={formatUsd(totals.knownCost)}
            detail={
              totals.unpricedCalls > 0
                ? `${formatTokens(totals.unpricedCalls)} calls unpriced`
                : "all calls priced"
            }
          />
          <UsageMetric
            label="Provider time"
            value={formatMs(totals.durationMs)}
          />
        </Grid>
      ) : null}

      <section className="border border-border bg-card p-4">
        <h2 className="mb-2 font-mono text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Usage by feature / model / day
        </h2>
        <Table className="table-auto">
          <TableHeader>
            <TableRow>
              <TableHead>Day</TableHead>
              <TableHead>Feature</TableHead>
              <TableHead>Provider</TableHead>
              <TableHead>Model</TableHead>
              <TableHead>Operation</TableHead>
              <TableHead>App cache</TableHead>
              <TableHead>Analysis cache</TableHead>
              <TableHead>Calls</TableHead>
              <TableHead>Input</TableHead>
              <TableHead>Output</TableHead>
              <TableHead>Cost</TableHead>
              <TableHead>Duration</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {summaryRows?.map((row) => (
              <TableRow
                key={`${row.day}:${row.feature}:${row.provider}:${row.model}:${row.operation}:${row.cacheStatus ?? ""}:${row.applicationCacheStatus ?? ""}`}
              >
                <TableCell>{row.day}</TableCell>
                <TableCell className="whitespace-normal">
                  {row.feature}
                </TableCell>
                <TableCell>{row.provider}</TableCell>
                <TableCell className="whitespace-normal">{row.model}</TableCell>
                <TableCell className="whitespace-normal">
                  {row.operation}
                </TableCell>
                <TableCell>{row.applicationCacheStatus ?? "-"}</TableCell>
                <TableCell>{row.cacheStatus ?? "-"}</TableCell>
                <TableCell>{formatTokens(row.count)}</TableCell>
                <TableCell>{formatTokens(row.inputTokens)}</TableCell>
                <TableCell>{formatTokens(row.outputTokens)}</TableCell>
                <TableCell>
                  <CostCell value={row.estimatedCost} />
                </TableCell>
                <TableCell>{formatMs(row.durationMs)}</TableCell>
              </TableRow>
            ))}
            <AiUsageTableStatus
              isLoading={summaryLoading}
              error={summaryError}
              isEmpty={summaryRows?.length === 0}
              emptyLabel="No AI usage recorded"
              retryLabel="Retry summary"
              onRetry={() => void summaryQuery.refetch()}
            />
          </TableBody>
        </Table>
      </section>

      <section className="border border-border bg-card p-4">
        <h2 className="mb-2 font-mono text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Recent calls
        </h2>
        <Table className="table-auto">
          <TableHeader>
            <TableRow>
              <TableHead>Created</TableHead>
              <TableHead>Feature</TableHead>
              <TableHead>Provider / model</TableHead>
              <TableHead>Operation</TableHead>
              <TableHead>App cache</TableHead>
              <TableHead>Analysis cache</TableHead>
              <TableHead>Entity</TableHead>
              <TableHead>Input</TableHead>
              <TableHead>Output</TableHead>
              <TableHead>Cost</TableHead>
              <TableHead>Duration</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {recentRows?.map((row) => (
              <TableRow key={row.id}>
                <TableCell>{row.createdAt.toLocaleString()}</TableCell>
                <TableCell className="whitespace-normal">
                  {row.feature}
                </TableCell>
                <TableCell className="whitespace-normal">
                  {row.provider} / {row.model}
                </TableCell>
                <TableCell className="whitespace-normal">
                  {row.operation}
                </TableCell>
                <TableCell>{row.applicationCacheStatus ?? "-"}</TableCell>
                <TableCell>{row.cacheStatus ?? "-"}</TableCell>
                <TableCell>
                  <UsageEntityLink row={row} />
                </TableCell>
                <TableCell>{formatTokens(row.inputTokens)}</TableCell>
                <TableCell>{formatTokens(row.outputTokens)}</TableCell>
                <TableCell>
                  <CostCell value={row.estimatedCost} />
                </TableCell>
                <TableCell>{formatMs(row.durationMs)}</TableCell>
              </TableRow>
            ))}
            <AiUsageTableStatus
              isLoading={recentLoading}
              error={recentError}
              isEmpty={recentRows?.length === 0}
              emptyLabel="No recent calls"
              retryLabel="Retry recent calls"
              onRetry={() => void recentQuery.refetch()}
              colSpan={10}
            />
          </TableBody>
        </Table>
      </section>
    </Stack>
  );
}
