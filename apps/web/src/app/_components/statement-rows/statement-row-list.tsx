import type {
  StatementRowDisposition,
  StatementRowFilters,
  StatementRowMatchState,
  StatementRowOut,
} from "@cubby/schemas/statement-row";
import { statementRowSortableFields } from "@cubby/schemas/statement-row";
import { capitalize } from "@cubby/shared";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { uniq } from "es-toolkit";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";

import { DatePickerInput } from "~/app/_components/date-picker-input";
import { PossibleVendor } from "~/app/finance/possible-vendor";
import { ErrorDisplay } from "~/components/feedback/error-display";
import { Row, Stack } from "~/components/layout";
import { usePageCount } from "~/components/page/Page";
import { type BadgeVariant, badgeVariantColor } from "~/components/ui/badge";
import type { FilterableComboboxItem } from "~/components/ui/combobox";
import { DrilldownMetricStrip } from "~/components/ui/drilldown-metric-strip";
import { Input } from "~/components/ui/input";
import { NativeSelect } from "~/components/ui/native-select";
import { NoneValue } from "~/components/ui/none-value";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { statementRow } from "~/lib/statement-row.functions";
import { formatCurrency } from "~/lib/utils";

import {
  createCurrencyColumn,
  createPlainDateColumn,
  renderOptionCell,
} from "../data-table/columnHelpers";
import RTable from "../data-table/Table";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
} from "../data-table/table-features";
import { useTableConfig } from "../data-table/useTableConfig";
import { useTableState } from "../data-table/useTableState";

const route = getRouteApi("/_authenticated/statement-rows/");

/** Client-only sentinel meaning "no matchState filter" — see the route file. */
type MatchStateSearchValue = StatementRowMatchState | "all";

// Stable defaults — a fresh `[]`/`{}` per render would destabilize every
// memo downstream while a query is loading (apps/web/AGENTS.md's
// `unstable-hook-default` rule).
const NO_ROWS: StatementRowOut[] = [];
const NO_SOURCES: string[] = [];

const MATCH_STATE_TONE = {
  matched: "positive",
  unmatched: "warning",
  superseded: "slate",
  ignored: "secondary",
} satisfies Record<StatementRowMatchState, BadgeVariant>;

const MATCH_STATE_VALUES = [
  "matched",
  "unmatched",
  "superseded",
  "ignored",
] as const satisfies readonly StatementRowMatchState[];
const matchStateSearchSchema = z.enum([...MATCH_STATE_VALUES, "all"] as const);

const MATCH_STATE_OPTIONS: FilterableComboboxItem[] = MATCH_STATE_VALUES.map(
  (value) => ({
    value,
    label: capitalize(value),
    color: badgeVariantColor[MATCH_STATE_TONE[value]],
  }),
);

const DISPOSITION_TONE = {
  open: "outline",
  ignored: "secondary",
} satisfies Record<StatementRowDisposition, BadgeVariant>;
const DISPOSITION_VALUES = [
  "open",
  "ignored",
] as const satisfies readonly StatementRowDisposition[];

const DISPOSITION_OPTIONS: FilterableComboboxItem[] = DISPOSITION_VALUES.map(
  (value) => ({
    value,
    label: capitalize(value),
    color: badgeVariantColor[DISPOSITION_TONE[value]],
  }),
);

/** Route search → server filters. `"all"` never reaches the wire — it's the
 * client-only way to say "no matchState filter" (see the route file). */
function buildFilters(search: {
  matchState?: MatchStateSearchValue;
  disposition?: StatementRowDisposition;
  source?: string;
  dateFrom?: string;
  dateTo?: string;
  q?: string;
}): StatementRowFilters {
  const matchState = search.matchState ?? "unmatched";
  return {
    matchState: matchState === "all" ? undefined : matchState,
    disposition: search.disposition,
    source: search.source,
    dateFrom: search.dateFrom,
    dateTo: search.dateTo,
    search: search.q,
  };
}

/** Debounced search box — writes to the URL 400ms after typing stops, rather
 * than on every keystroke (this filter is server-side, unlike table filters). */
function SearchBox({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [text, setText] = useState(value);
  const [debounced] = useDebouncedValue(text, { wait: 400 });
  const lastRef = useRef(value);

  useEffect(() => {
    if (debounced === lastRef.current) return;
    lastRef.current = debounced;
    onChange(debounced);
    // oxlint-disable-next-line react/exhaustive-deps -- onChange is the navigate callback, stable per render cycle; including it would refire on every parent render
  }, [debounced]);

  // External reset (e.g. a "Clear filters" action) — sync without fighting
  // the user's in-flight typing.
  if (value !== lastRef.current && value !== text) {
    lastRef.current = value;
    setText(value);
  }

  return (
    <Input
      value={text}
      onChange={(e) => setText(e.target.value)}
      placeholder="Search description..."
      className="max-w-xs"
    />
  );
}

/**
 * Total / matched / unmatched / ignored counts plus the unmatched dollar
 * amount, computed over the active filters MINUS matchState — so the tiles
 * show the full breakdown regardless of which state the table is currently
 * showing, and each tile is a one-click way to switch to it (mirroring
 * TasksStatsStrip).
 */
function StatementRowSummary({
  filters,
  matchState,
  onSelectMatchState,
}: {
  filters: StatementRowFilters;
  matchState: MatchStateSearchValue;
  onSelectMatchState: (value: MatchStateSearchValue) => void;
}) {
  const summaryFilters = useMemo<StatementRowFilters>(
    () => ({ ...filters, matchState: undefined }),
    [filters],
  );
  const { data, isLoading, error } = useQuery(
    statementRow.summary.queryOptions({ filters: summaryFilters }),
  );

  // A settled query with no data means it errored — `isLoading` alone would
  // leave this stuck on the skeleton forever instead of surfacing the error.
  if (error) return <ErrorDisplay error={error} />;
  if (isLoading || !data) return <DrilldownMetricStrip loadingCount={5} />;

  const selectable = (
    label: string,
    value: number,
    target: MatchStateSearchValue,
  ) => ({
    label,
    value,
    active: matchState === target,
    onSelect: () => onSelectMatchState(target),
  });

  return (
    <DrilldownMetricStrip
      metrics={[
        selectable("Total", data.total, "all"),
        selectable("Matched", data.matched, "matched"),
        selectable("Unmatched", data.unmatched, "unmatched"),
        selectable("Ignored", data.ignored, "ignored"),
        {
          label: "Unmatched $",
          value: formatCurrency(data.unmatchedAmount),
        },
      ]}
    />
  );
}

function StatementRowFilterBar({
  search,
  onUpdate,
}: {
  search: {
    matchState?: MatchStateSearchValue;
    disposition?: StatementRowDisposition;
    source?: string;
    dateFrom?: string;
    dateTo?: string;
    q?: string;
  };
  onUpdate: (
    patch: Partial<{
      matchState: MatchStateSearchValue;
      disposition: StatementRowDisposition | undefined;
      source: string | undefined;
      dateFrom: string | undefined;
      dateTo: string | undefined;
      q: string | undefined;
    }>,
  ) => void;
}) {
  const importsQuery = useQuery(statementRow.imports.queryOptions({}));
  const sourceOptions = useMemo(
    () =>
      importsQuery.data
        ? uniq(importsQuery.data.data.map((imp) => imp.source)).sort()
        : NO_SOURCES,
    [importsQuery.data],
  );

  return (
    <Row gap="sm" wrap align="center">
      <SearchBox
        value={search.q ?? ""}
        onChange={(q) => onUpdate({ q: q || undefined })}
      />
      <NativeSelect
        aria-label="Match state"
        value={search.matchState ?? "unmatched"}
        onChange={(e) =>
          onUpdate({ matchState: matchStateSearchSchema.parse(e.target.value) })
        }
      >
        <option value="unmatched">Unmatched</option>
        <option value="matched">Matched</option>
        <option value="superseded">Superseded</option>
        <option value="ignored">Ignored</option>
        <option value="all">All</option>
      </NativeSelect>
      <NativeSelect
        aria-label="Disposition"
        value={search.disposition ?? ""}
        onChange={(e) =>
          onUpdate({
            disposition: e.target.value
              ? (DISPOSITION_VALUES.find((value) => value === e.target.value) ??
                undefined)
              : undefined,
          })
        }
      >
        <option value="">Any disposition</option>
        <option value="open">Open</option>
        <option value="ignored">Ignored</option>
      </NativeSelect>
      <NativeSelect
        aria-label="Source"
        value={search.source ?? ""}
        onChange={(e) => onUpdate({ source: e.target.value || undefined })}
      >
        <option value="">All sources</option>
        {sourceOptions.map((source) => (
          <option key={source} value={source}>
            {source}
          </option>
        ))}
      </NativeSelect>
      <Row align="center" gap="xs" className="text-sm text-muted-foreground">
        <span>From</span>
        <DatePickerInput
          aria-label="Statement date from"
          value={search.dateFrom ?? null}
          clearable
          onChange={(value) => onUpdate({ dateFrom: value ?? undefined })}
          className="w-44"
        />
        <span>to</span>
        <DatePickerInput
          aria-label="Statement date to"
          value={search.dateTo ?? null}
          clearable
          onChange={(value) => onUpdate({ dateTo: value ?? undefined })}
          className="w-44"
        />
      </Row>
    </Row>
  );
}

const columnHelper = createCubbyColumnHelper<StatementRowOut>();

type StatementRowSortField = (typeof statementRowSortableFields)[number];

const isStatementRowSortField = (
  value: string,
): value is StatementRowSortField =>
  statementRowSortableFields.some((field) => field === value);

export function StatementRowList() {
  const search = route.useSearch();
  const navigate = route.useNavigate();

  const updateFilter = useCallback(
    (
      patch: Partial<{
        matchState: MatchStateSearchValue;
        disposition: StatementRowDisposition | undefined;
        source: string | undefined;
        dateFrom: string | undefined;
        dateTo: string | undefined;
        q: string | undefined;
      }>,
    ) => {
      void navigate({ search: (prev) => ({ ...prev, ...patch }) });
    },
    [navigate],
  );

  // Sort + pagination are local UI state, not URL-synced — mirroring
  // usdafoodlist.tsx, the referenced non-entity RTable model. Only the filter
  // state (above) needs to be linkable.
  const tableState = useTableState({ initialSort: "statementDate" });

  const filters = useMemo(() => buildFilters(search), [search]);

  // Filters aren't routed through TanStack's columnFilters (they're custom
  // URL state, not header-column filters), so they miss useTableState's
  // built-in "reset to page 1 on filter change" behavior — do it explicitly,
  // or switching filters mid-page-3 strands the user on a stale/empty page.
  const filtersKey = JSON.stringify(filters);
  const previousFiltersKey = useRef(filtersKey);
  const { setPagination } = tableState;
  useEffect(() => {
    if (previousFiltersKey.current === filtersKey) return;
    previousFiltersKey.current = filtersKey;
    setPagination((p) => (p.pageIndex === 0 ? p : { ...p, pageIndex: 0 }));
  }, [filtersKey, setPagination]);

  const sortParams = tableState.getSortParams();
  const sort: { orderBy: StatementRowSortField; direction: "asc" | "desc" } =
    isStatementRowSortField(sortParams.orderBy)
      ? {
          orderBy: sortParams.orderBy,
          direction: sortParams.direction,
        }
      : { orderBy: "statementDate", direction: sortParams.direction };

  const listQuery = useQuery(
    statementRow.list.queryOptions({
      filters,
      sort,
      pagination: tableState.pagination,
    }),
  );
  usePageCount(listQuery.data?.count);

  // The amount column's footer would otherwise sum only the loaded PAGE
  // (createCurrencyColumn falls back to a client-side reduction) — a second,
  // cheap aggregate query over the same (matchState-inclusive) filters gives
  // it the true full-filtered-set total instead.
  const footerTotalsQuery = useQuery(
    statementRow.summary.queryOptions({ filters }),
  );

  const columns = useMemo(
    () =>
      createCubbyColumnCollection<StatementRowOut>((add) => {
        add(
          createPlainDateColumn(columnHelper, "statementDate", {
            header: "Date",
            className: "w-24",
          }),
        );
        add(
          columnHelper.accessor("accountDescriptor", {
            id: "accountDescriptor",
            header: "Account",
            enableSorting: true,
            meta: { className: "w-48" },
            cell: (info) => {
              const row = info.row.original;
              return (
                <Stack gap="tight" className="min-w-0">
                  <span
                    className="block truncate"
                    title={row.accountDescriptor}
                  >
                    {row.accountDescriptor}
                  </span>
                  {row.accountName && (
                    <span
                      className="block truncate text-2xs text-muted-foreground"
                      title={row.accountName}
                    >
                      {row.accountName}
                    </span>
                  )}
                </Stack>
              );
            },
          }),
        );
        add(
          columnHelper.accessor("rawDescription", {
            id: "rawDescription",
            header: "Description",
            enableSorting: true,
            meta: { className: "w-72" },
            cell: (info) => (
              <Tooltip>
                <TooltipTrigger render={<span className="block truncate" />}>
                  {info.getValue()}
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-xs">
                  {info.getValue()}
                </TooltipContent>
              </Tooltip>
            ),
          }),
        );
        add(
          columnHelper.accessor("merchant", {
            id: "merchant",
            header: "Merchant",
            enableSorting: false,
            meta: { className: "w-40" },
            cell: (info) => {
              const value = info.getValue();
              return value ? (
                <span className="block truncate">{value}</span>
              ) : (
                <NoneValue />
              );
            },
          }),
        );
        add(
          columnHelper.accessor("vendorInference", {
            id: "possibleVendor",
            header: "Possible vendor",
            enableSorting: false,
            meta: {
              className: "w-48",
              mobile: {
                slot: "meta",
                priority: 15,
                interactive: true,
              },
            },
            cell: (info) =>
              info.getValue() ? (
                <PossibleVendor inference={info.getValue()} compact />
              ) : (
                <NoneValue />
              ),
          }),
        );
        add(
          createCurrencyColumn(columnHelper, "amount", {
            header: "Amount",
            className: "w-24",
            signedTone: true,
          }),
        );
        add(
          columnHelper.accessor("matchState", {
            id: "matchState",
            header: "Match",
            enableSorting: false,
            meta: { className: "w-28" },
            cell: (info) =>
              renderOptionCell(info.getValue(), MATCH_STATE_OPTIONS),
          }),
        );
        add(
          columnHelper.accessor("source", {
            id: "source",
            header: "Source",
            enableSorting: false,
            meta: { className: "w-24", mono: true },
            cell: (info) => info.getValue(),
          }),
        );
        add(
          columnHelper.accessor("disposition", {
            id: "disposition",
            header: "Disposition",
            enableSorting: false,
            meta: { className: "w-32" },
            cell: (info) => {
              const row = info.row.original;
              // The reason stays a hover title — it is free-form prose, not part of
              // the taxonomy label.
              return (
                <span title={row.dispositionReason ?? undefined}>
                  {renderOptionCell(row.disposition, DISPOSITION_OPTIONS)}
                </span>
              );
            },
          }),
        );
        add(
          columnHelper.accessor("transactionId", {
            id: "transactionId",
            header: "Transaction",
            enableSorting: false,
            meta: { className: "w-28" },
            // This narrow projection only carries the transaction shortcode, not
            // the displayName required by EntityInlineLink.
            cell: (info) => {
              const transactionId = info.getValue();
              if (!transactionId) return <NoneValue />;
              return (
                <Link
                  to="/financial-transactions/$shortcode"
                  params={{ shortcode: transactionId }}
                  title={transactionId}
                  className="block truncate font-mono text-primary hover:underline"
                >
                  {transactionId}
                </Link>
              );
            },
          }),
        );
      }),
    [],
  );

  const totalCount = listQuery.data?.count ?? 0;
  const amountTotal = footerTotalsQuery.data?.amountTotal;
  const serverTotals = useMemo(
    () =>
      amountTotal === undefined
        ? undefined
        : { totalCount, sums: { amount: amountTotal } },
    [totalCount, amountTotal],
  );

  const table = useTableConfig({
    data: listQuery.data?.data ?? NO_ROWS,
    columns,
    tableState,
    totalCount,
    getRowId: (row) => `${row.source}:${row.externalId}`,
    serverTotals,
  });

  return (
    <Stack gap="md">
      <StatementRowSummary
        filters={filters}
        matchState={search.matchState ?? "unmatched"}
        onSelectMatchState={(matchState) => updateFilter({ matchState })}
      />
      <StatementRowFilterBar search={search} onUpdate={updateFilter} />
      <RTable
        table={table}
        isLoading={listQuery.isLoading}
        error={listQuery.error}
        ariaLabel="Statement Rows Table"
      />
    </Stack>
  );
}
