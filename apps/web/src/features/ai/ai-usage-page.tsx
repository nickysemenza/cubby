import type {
  AiUsageEntry,
  AiUsageRecentFilters,
  AiUsageSummaryRow,
  AiUsageTransport,
} from "@cubby/schemas/ai";
import { AI_USAGE_TRANSPORT_LABELS as transportLabels } from "@cubby/schemas/telemetry";
import { parseShortcode } from "@cubby/shared";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { RowData } from "@tanstack/react-table";
import { type ReactNode, useId, useMemo, useState } from "react";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { ai } from "~/integrations/tanstack-query/generated/catalog.gen";
import { formatInstant } from "~/lib/date-format";
import { formatCount, formatCurrency } from "~/lib/utils";
import { useTableColumnLayout } from "~/ui/data-table/column-layout";
import RTable from "~/ui/data-table/Table";
import {
  type CubbyColumnCollection,
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  useCubbyTable,
} from "~/ui/data-table/table-features";
import { useHydrated } from "~/ui/hooks/useHydrated";
import { Grid, Row, Stack } from "~/ui/layout";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import { Input } from "~/ui/primitives/input";
import { NativeSelect } from "~/ui/primitives/native-select";

const supportedEntityKinds = [
  "product",
  "location",
  "recipe",
  "ingredient",
  "inventory",
] as const;

type SupportedEntityKind = (typeof supportedEntityKinds)[number];
type AiUsageStatus = AiUsageEntry["status"];

const statusLabels = {
  succeeded: "Succeeded",
  failed: "Failed",
} satisfies Record<AiUsageStatus, string>;

interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  knownCost: number;
  unpricedCalls: number;
  durationMs: number;
}

function isSupportedEntityKind(
  value: string | null,
): value is SupportedEntityKind {
  return supportedEntityKinds.some((entityKind) => entityKind === value);
}

function isTransport(value: string): value is AiUsageTransport {
  return Object.hasOwn(transportLabels, value);
}

function isStatus(value: string): value is AiUsageStatus {
  return Object.hasOwn(statusLabels, value);
}

function formatTokens(value: number | null | undefined): string {
  return formatCount(value ?? 0);
}

const formatUsageCost = (value: number | null | undefined): string =>
  value == null
    ? "unpriced"
    : formatCurrency(value, 6, { minimumFractionDigits: 4 });

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

/** Distinct values of one summary dimension, plus the active choice so a
 * selection outside the summary window stays visible in its select. */
function dimensionOptions(
  rows: AiUsageSummaryRow[] | undefined,
  key: "provider" | "model" | "feature",
  selected: string | undefined,
): string[] {
  const values = new Set(rows?.map((row) => row[key]));
  if (selected) values.add(selected);
  return [...values].sort((a, b) => a.localeCompare(b));
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

/** Exported for the UUID-boundary regression test; not part of the page's public surface. */
export function UsageEntityLink({
  row,
}: {
  row: Pick<AiUsageEntry, "entityKind" | "entityId">;
}) {
  if (!row.entityKind || !row.entityId) {
    return <span className="text-muted-foreground">-</span>;
  }
  if (!isSupportedEntityKind(row.entityKind)) {
    return <span className="text-muted-foreground">{row.entityKind}</span>;
  }

  // AiUsage.entityId is recorded from queue/side-effect payloads that carry
  // private uuids, while EntityRefLink (byId) expects a public shortcode.
  // Never send a uuid into that boundary.
  if (parseShortcode(row.entityId)?.type !== row.entityKind) {
    return (
      <span className="text-muted-foreground">
        {row.entityKind} · {row.entityId.slice(0, 8)}
      </span>
    );
  }

  return (
    <EntityRefLink
      variant="byId"
      entityKind={row.entityKind}
      entityId={row.entityId}
      compact
    />
  );
}

function CostCell({ value }: { value: number | null }) {
  return (
    <span className={value == null ? "text-muted-foreground" : undefined}>
      {formatUsageCost(value)}
    </span>
  );
}

function UsageSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="border border-border bg-card p-4"
    >
      <h2
        id={headingId}
        className="mb-2 font-mono text-xs font-semibold tracking-wide text-muted-foreground uppercase"
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

function useUsageTable<TRow extends RowData>({
  data,
  columns,
  getRowId,
  enableSorting,
}: {
  data: TRow[];
  columns: CubbyColumnCollection<TRow>;
  getRowId: (row: TRow) => string;
  enableSorting: boolean;
}) {
  const { columns: tableColumns, defaultLayout } = useTableColumnLayout({
    columns,
  });
  return useCubbyTable({
    data,
    columns: tableColumns,
    initialState: {
      columnOrder: defaultLayout.columnOrder,
      columnPinning: defaultLayout.columnPinning,
      columnVisibility: defaultLayout.columnVisibility,
    },
    meta: { defaultLayout },
    getRowId,
    manualFiltering: true,
    manualPagination: true,
    enableSorting,
    enableRowSelection: false,
    enableCellSelection: false,
  });
}

const noSummaryRows: AiUsageSummaryRow[] = [];
const noRecentRows: AiUsageEntry[] = [];

/** SQL grouping identity, shared with the row-reconciliation regression. */
export function aiUsageSummaryRowId(
  row: Pick<
    AiUsageSummaryRow,
    | "day"
    | "feature"
    | "provider"
    | "model"
    | "transport"
    | "operation"
    | "jobKind"
    | "jobId"
    | "cacheStatus"
    | "applicationCacheStatus"
  >,
): string {
  return JSON.stringify([
    row.day,
    row.feature,
    row.provider,
    row.model,
    row.transport,
    row.operation,
    row.jobKind,
    row.jobId,
    row.cacheStatus,
    row.applicationCacheStatus,
  ]);
}

function SummaryTable({
  rows,
  isLoading,
  error,
  onRetry,
}: {
  rows: AiUsageSummaryRow[] | undefined;
  isLoading: boolean;
  error: unknown;
  onRetry: () => Promise<void>;
}) {
  const columns = useMemo(() => {
    const helper = createCubbyColumnHelper<AiUsageSummaryRow>();
    return createCubbyColumnCollection<AiUsageSummaryRow>((add) => {
      add(
        helper.accessor("day", {
          header: "Day",
          size: 120,
          meta: { mono: true, mobile: { slot: "subtitle", priority: 0 } },
        }),
      );
      add(
        helper.accessor("feature", {
          header: "Feature",
          size: 180,
          meta: { mobile: { slot: "title", priority: 0 } },
        }),
      );
      add(
        helper.accessor("provider", {
          header: "Provider",
          size: 120,
          meta: { mobile: { slot: "meta", priority: 10 } },
        }),
      );
      add(
        helper.accessor("model", {
          header: "Model",
          size: 180,
          meta: { mono: true, mobile: { slot: "meta", priority: 20 } },
        }),
      );
      add(
        helper.accessor((row) => transportLabels[row.transport], {
          id: "transport",
          header: "Transport",
          size: 110,
          meta: { mobile: { slot: "meta", priority: 30 } },
        }),
      );
      add(
        helper.accessor("operation", {
          header: "Operation",
          size: 200,
          meta: { mono: true, mobile: { slot: "meta", priority: 40 } },
        }),
      );
      add(
        helper.accessor((row) => row.applicationCacheStatus ?? "-", {
          id: "applicationCacheStatus",
          header: "App cache",
          size: 100,
          meta: { mobile: { slot: "meta", priority: 60 } },
        }),
      );
      add(
        helper.accessor((row) => row.cacheStatus ?? "-", {
          id: "cacheStatus",
          header: "Analysis cache",
          size: 120,
          meta: { mobile: { slot: "meta", priority: 70 } },
        }),
      );
      add(
        helper.accessor("count", {
          header: "Calls",
          size: 90,
          meta: { numeric: true, mobile: { slot: "trailing", priority: 0 } },
          cell: ({ getValue }) => formatTokens(getValue()),
        }),
      );
      add(
        helper.accessor("inputTokens", {
          header: "Input",
          size: 100,
          meta: { numeric: true, mobile: { slot: "meta", priority: 80 } },
          cell: ({ getValue }) => formatTokens(getValue()),
        }),
      );
      add(
        helper.accessor("outputTokens", {
          header: "Output",
          size: 100,
          meta: { numeric: true, mobile: { slot: "meta", priority: 90 } },
          cell: ({ getValue }) => formatTokens(getValue()),
        }),
      );
      add(
        helper.accessor("estimatedCost", {
          header: "Cost",
          size: 120,
          meta: { numeric: true, mobile: { slot: "trailing", priority: 10 } },
          cell: ({ getValue }) => <CostCell value={getValue()} />,
        }),
      );
      add(
        helper.accessor("durationMs", {
          header: "Duration",
          size: 100,
          meta: { numeric: true, mobile: { slot: "meta", priority: 100 } },
          cell: ({ getValue }) => formatMs(getValue()),
        }),
      );
    });
  }, []);
  const table = useUsageTable({
    data: rows ?? noSummaryRows,
    columns,
    getRowId: aiUsageSummaryRowId,
    enableSorting: true,
  });

  return (
    <RTable
      table={table}
      ariaLabel="Usage by feature, model, and day"
      embedded
      showColumnMenu
      isLoading={isLoading}
      error={error}
      refreshControls={{ onRefresh: onRetry, isRefreshing: false }}
      emptyState="No AI usage recorded"
    />
  );
}

function RecentTable({
  rows,
  isLoading,
  error,
  onRetry,
  filtered,
  toolbar,
}: {
  rows: AiUsageEntry[] | undefined;
  isLoading: boolean;
  error: unknown;
  onRetry: () => Promise<void>;
  filtered: boolean;
  toolbar: ReactNode;
}) {
  const columns = useMemo(() => {
    const helper = createCubbyColumnHelper<AiUsageEntry>();
    return createCubbyColumnCollection<AiUsageEntry>((add) => {
      add(
        helper.accessor("createdAt", {
          header: "Created",
          size: 170,
          meta: { mono: true, mobile: { slot: "subtitle", priority: 0 } },
          cell: ({ getValue }) => formatInstant(getValue(), "dateTime"),
        }),
      );
      add(
        helper.accessor("feature", {
          header: "Feature",
          size: 180,
          meta: { mobile: { slot: "meta", priority: 10 } },
        }),
      );
      add(
        helper.accessor((row) => `${row.provider} / ${row.model}`, {
          id: "providerModel",
          header: "Provider / model",
          size: 220,
          meta: { mono: true, mobile: { slot: "meta", priority: 20 } },
        }),
      );
      add(
        helper.accessor((row) => transportLabels[row.transport], {
          id: "transport",
          header: "Transport",
          size: 110,
          meta: { mobile: { slot: "meta", priority: 30 } },
        }),
      );
      add(
        helper.accessor("status", {
          header: "Status",
          size: 110,
          meta: { mobile: { slot: "trailing", priority: 0 } },
          cell: ({ getValue }) => (
            <Badge
              variant={getValue() === "failed" ? "destructive" : "outline"}
            >
              {statusLabels[getValue()]}
            </Badge>
          ),
        }),
      );
      add(
        helper.accessor("operation", {
          header: "Operation",
          size: 220,
          meta: { mono: true, mobile: { slot: "title", priority: 0 } },
        }),
      );
      add(
        helper.accessor((row) => row.applicationCacheStatus ?? "-", {
          id: "applicationCacheStatus",
          header: "App cache",
          size: 100,
          meta: { mobile: { slot: "meta", priority: 60 } },
        }),
      );
      add(
        helper.accessor((row) => row.cacheStatus ?? "-", {
          id: "cacheStatus",
          header: "Analysis cache",
          size: 120,
          meta: { mobile: { slot: "meta", priority: 70 } },
        }),
      );
      add(
        helper.display({
          id: "entity",
          header: "Entity",
          size: 200,
          meta: { mobile: { slot: "meta", priority: 40 } },
          cell: ({ row }) => <UsageEntityLink row={row.original} />,
        }),
      );
      add(
        helper.accessor("inputTokens", {
          header: "Input",
          size: 100,
          meta: { numeric: true, mobile: { slot: "meta", priority: 80 } },
          cell: ({ getValue }) => formatTokens(getValue()),
        }),
      );
      add(
        helper.accessor("outputTokens", {
          header: "Output",
          size: 100,
          meta: { numeric: true, mobile: { slot: "meta", priority: 90 } },
          cell: ({ getValue }) => formatTokens(getValue()),
        }),
      );
      add(
        helper.accessor("estimatedCost", {
          header: "Cost",
          size: 120,
          meta: { numeric: true, mobile: { slot: "trailing", priority: 10 } },
          cell: ({ getValue }) => <CostCell value={getValue()} />,
        }),
      );
      add(
        helper.accessor("durationMs", {
          header: "Duration",
          size: 100,
          meta: { numeric: true, mobile: { slot: "meta", priority: 100 } },
          cell: ({ getValue }) => formatMs(getValue()),
        }),
      );
    });
  }, []);
  const table = useUsageTable({
    data: rows ?? noRecentRows,
    columns,
    getRowId: (row) => row.id,
    // Rows arrive newest-first from a server-limited window; a local sort
    // would only reorder that window.
    enableSorting: false,
  });

  return (
    <RTable
      table={table}
      ariaLabel="Recent AI calls"
      embedded
      showColumnMenu
      additionalToolbarContent={toolbar}
      isLoading={isLoading}
      error={error}
      refreshControls={{ onRefresh: onRetry, isRefreshing: false }}
      emptyState={
        filtered ? "No recent calls match these filters." : "No recent calls"
      }
    />
  );
}

function DimensionSelect({
  label,
  allLabel,
  options,
  value,
  onChange,
}: {
  label: string;
  allLabel: string;
  options: string[];
  value: string | undefined;
  onChange: (value: string | undefined) => void;
}) {
  return (
    <NativeSelect
      aria-label={label}
      value={value ?? ""}
      onChange={(event) => onChange(event.target.value || undefined)}
    >
      <option value="">{allLabel}</option>
      {options.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </NativeSelect>
  );
}

export function AiUsagePage() {
  const [days, setDays] = useState(7);
  const [recentLimit, setRecentLimit] = useState(50);
  const [filters, setFilters] = useState<Omit<AiUsageRecentFilters, "query">>(
    {},
  );
  const [queryText, setQueryText] = useState("");
  const [debouncedQuery] = useDebouncedValue(queryText.trim(), { wait: 300 });
  const recentFilters = useMemo<AiUsageRecentFilters>(
    () => ({ ...filters, query: debouncedQuery || undefined }),
    [filters, debouncedQuery],
  );
  const filtered = Object.values(recentFilters).some(Boolean);
  const summaryQuery = useQuery(ai.usageSummary.queryOptions({ days }));
  // Filters travel to the server so they apply before the row limit; a local
  // filter over the newest rows would hide older matches.
  const recentQuery = useQuery({
    ...ai.usageRecent.queryOptions({
      limit: recentLimit,
      filters: filtered ? recentFilters : undefined,
    }),
    placeholderData: keepPreviousData,
  });
  // Hydration-stable. Whether a query's data has landed differs between the SSR
  // render and the first client render — TanStack Start's query stream races
  // React's hydration and can win in either direction. RTable gates its rows on
  // hydration itself; the metrics above it gate here so both renders match.
  const hydrated = useHydrated();
  const summaryRows = summaryQuery.error ? undefined : summaryQuery.data;
  const totals = useMemo(
    () => usageTotals((hydrated ? summaryRows : undefined) ?? []),
    [hydrated, summaryRows],
  );
  const setFilter = <K extends keyof typeof filters>(
    key: K,
    value: (typeof filters)[K],
  ) => setFilters((current) => ({ ...current, [key]: value }));

  const recentToolbar = (
    <Row gap="sm" align="center" wrap>
      <Input
        aria-label="Search recent calls"
        placeholder="Search calls…"
        className="w-48"
        value={queryText}
        onChange={(event) => setQueryText(event.target.value)}
      />
      <NativeSelect
        aria-label="Transport"
        value={filters.transport ?? ""}
        onChange={(event) => {
          const value = event.target.value;
          setFilter("transport", isTransport(value) ? value : undefined);
        }}
      >
        <option value="">All transports</option>
        {Object.entries(transportLabels).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </NativeSelect>
      <NativeSelect
        aria-label="Status"
        value={filters.status ?? ""}
        onChange={(event) => {
          const value = event.target.value;
          setFilter("status", isStatus(value) ? value : undefined);
        }}
      >
        <option value="">All statuses</option>
        {Object.entries(statusLabels).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </NativeSelect>
      <DimensionSelect
        label="Provider"
        allLabel="All providers"
        options={dimensionOptions(summaryRows, "provider", filters.provider)}
        value={filters.provider}
        onChange={(value) => setFilter("provider", value)}
      />
      <DimensionSelect
        label="Model"
        allLabel="All models"
        options={dimensionOptions(summaryRows, "model", filters.model)}
        value={filters.model}
        onChange={(value) => setFilter("model", value)}
      />
      <DimensionSelect
        label="Feature"
        allLabel="All features"
        options={dimensionOptions(summaryRows, "feature", filters.feature)}
        value={filters.feature}
        onChange={(value) => setFilter("feature", value)}
      />
      {filtered ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setFilters({});
            setQueryText("");
          }}
        >
          Clear
        </Button>
      ) : null}
    </Row>
  );

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

      {!summaryQuery.error ? (
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
            value={formatUsageCost(totals.knownCost)}
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

      <UsageSection title="Usage by feature / model / day">
        <SummaryTable
          rows={summaryRows}
          isLoading={summaryQuery.isLoading}
          error={summaryQuery.error}
          onRetry={async () => {
            await summaryQuery.refetch();
          }}
        />
      </UsageSection>

      <UsageSection title="Recent calls">
        <RecentTable
          rows={recentQuery.error ? undefined : recentQuery.data}
          isLoading={recentQuery.isLoading}
          error={recentQuery.error}
          onRetry={async () => {
            await recentQuery.refetch();
          }}
          filtered={filtered}
          toolbar={recentToolbar}
        />
      </UsageSection>
    </Stack>
  );
}
