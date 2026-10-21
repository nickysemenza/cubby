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
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { z } from "zod";

import { usePageCount } from "~/entity/page/page";
import { PossibleVendor } from "~/features/finance/possible-vendor";
import { statementRow } from "~/integrations/tanstack-query/generated/catalog.gen";
import { formatCount, formatCurrency } from "~/lib/number-format";
import { statusTone } from "~/lib/status-tone";
import { Picker } from "~/ui/combobox/picker";
import type { PickerOption } from "~/ui/combobox/picker-option";
import { KeyNumbers } from "~/ui/common/key-numbers";
import { DatePickerInput } from "~/ui/date-picker-input";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import type { ListQueryOptionsFn } from "~/ui/hooks/use-paginated-table-core";
import { Row, Stack } from "~/ui/layout";
import { badgeVariantColor } from "~/ui/primitives/badge";
import { Input } from "~/ui/primitives/input";
import { NoneValue } from "~/ui/primitives/none-value";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/ui/primitives/tooltip";

import {
  createCurrencyColumn,
  createPlainDateColumn,
  renderOptionCell,
} from "../../entity/table/column-helpers";
import { ListWorkbench } from "../../entity/table/list-workbench";
import { useChildListWorkbench } from "../../entity/table/use-child-list-workbench";
import { useTableState } from "../../entity/table/use-table-state";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
} from "../../ui/data-table/table-features";

const route = getRouteApi("/_authenticated/statement-rows/");

/** Client-only sentinel meaning "no matchState filter" — see the route file. */
type MatchStateSearchValue = StatementRowMatchState | "all";

// Stable defaults — a fresh `[]`/`{}` per render would destabilize every
// memo downstream while a query is loading (apps/web/AGENTS.md's
// `unstable-hook-default` rule).
const NO_SOURCES: string[] = [];

const MATCH_STATE_VALUES = [
  "matched",
  "unmatched",
  "superseded",
  "ignored",
] as const satisfies readonly StatementRowMatchState[];
const matchStateSearchSchema = z.enum([...MATCH_STATE_VALUES, "all"] as const);

const MATCH_STATE_OPTIONS: PickerOption[] = MATCH_STATE_VALUES.map((value) => ({
  value,
  label: capitalize(value),
  color: badgeVariantColor[statusTone("statementMatch", value)],
}));

const DISPOSITION_VALUES = [
  "open",
  "ignored",
] as const satisfies readonly StatementRowDisposition[];

const DISPOSITION_OPTIONS: PickerOption[] = DISPOSITION_VALUES.map((value) => ({
  value,
  label: capitalize(value),
  color: badgeVariantColor[statusTone("statementDisposition", value)],
}));

const MATCH_STATE_FILTER_OPTIONS: PickerOption[] = [
  ...MATCH_STATE_OPTIONS,
  { value: "all", label: "All" },
];
const DISPOSITION_FILTER_OPTIONS: PickerOption[] = [
  { value: "", label: "Any disposition" },
  ...DISPOSITION_OPTIONS,
];

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
  const matchState = search.matchState ?? "all";
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
 * The tiles' summary: the active filters MINUS matchState. The table footer
 * reads its selected state's amount from this same query.
 */
const summaryQueryOptions = (filters: StatementRowFilters) =>
  statementRow.summary.queryOptions({
    filters: { ...filters, matchState: undefined },
  });

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
  const { data, isLoading, error } = useQuery(summaryQueryOptions(filters));

  // A settled query with no data means it errored — `isLoading` alone would
  // leave this stuck on the skeleton forever instead of surfacing the error.
  if (error) return <ErrorDisplay error={error} />;
  if (isLoading || !data)
    return (
      <KeyNumbers
        layout="strip"
        label="Statement rows"
        items={[]}
        loadingCount={5}
      />
    );

  const selectable = (
    label: string,
    value: ReactNode,
    target: MatchStateSearchValue,
  ) => ({
    label,
    value,
    active: matchState === target,
    onSelect: () => onSelectMatchState(target),
  });

  return (
    <KeyNumbers
      layout="strip"
      label="Statement rows"
      items={[
        selectable("Total", data.total, "all"),
        selectable("Matched", data.matched, "matched"),
        selectable(
          "Unmatched",
          // Rows are observations; charges are the distinct money behind them.
          `${formatCount(data.unmatched)} rows · ${formatCount(data.unmatchedCharges)} charges`,
          "unmatched",
        ),
        selectable("Ignored", data.ignored, "ignored"),
        {
          label: "Unmatched $",
          value: formatCurrency(data.unmatchedAmount),
          money: true,
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
  const sourcePickerOptions = useMemo(
    (): PickerOption[] => [
      { value: "", label: "All sources" },
      ...(importsQuery.data
        ? uniq(importsQuery.data.data.map((imp) => imp.source)).sort()
        : NO_SOURCES
      ).map((source) => ({ value: source, label: source })),
    ],
    [importsQuery.data],
  );

  return (
    <Row gap="sm" wrap align="center">
      <SearchBox
        value={search.q ?? ""}
        onChange={(q) => onUpdate({ q: q || undefined })}
      />
      <Picker
        mode="choose"
        label="Match state"
        options={MATCH_STATE_FILTER_OPTIONS}
        value={search.matchState ?? "all"}
        onValueChange={(next) =>
          onUpdate({ matchState: matchStateSearchSchema.parse(next) })
        }
      />
      <Picker
        mode="choose"
        label="Disposition"
        options={DISPOSITION_FILTER_OPTIONS}
        value={search.disposition ?? ""}
        onValueChange={(next) =>
          onUpdate({
            disposition: next
              ? (DISPOSITION_VALUES.find((value) => value === next) ??
                undefined)
              : undefined,
          })
        }
      />
      <Picker
        label="Source"
        className="w-48"
        options={sourcePickerOptions}
        value={search.source ?? ""}
        onValueChange={(next) => onUpdate({ source: next || undefined })}
      />
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

/** Preserve the operation descriptor and cancellation while adapting its page shape. */
const statementRowsPlan: ListQueryOptionsFn<
  StatementRowFilters,
  StatementRowOut
> = ({ filters, pagination, sort }) => {
  const firstSort = sort?.[0];
  const input: Parameters<typeof statementRow.list.call>[0] = {
    filters,
    pagination,
    sort: [
      {
        orderBy:
          firstSort && isStatementRowSortField(firstSort.orderBy)
            ? firstSort.orderBy
            : "statementDate",
        direction: firstSort?.direction ?? "asc",
      },
    ],
  };
  const options = statementRow.list.queryOptions(input);
  return {
    queryKey: options.queryKey,
    meta: options.meta,
    execute: async (signal) => {
      const page = await statementRow.list.call(input, { signal });
      return {
        items: page.data,
        meta: { ...pagination, totalCount: page.count },
      };
    },
  };
};

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

  const tableState = useTableState({
    initialSort: "statementDate",
    readUrlState: false,
  });
  const filters = useMemo(() => buildFilters(search), [search]);

  // Tiles and footer share one full-filtered-set summary, independent of
  // loaded pages. An unavailable total leaves the footer empty.
  const summaryQuery = useQuery(summaryQueryOptions(filters));

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
                <span
                  className="block truncate"
                  title={[row.accountDescriptor, row.accountName]
                    .filter(Boolean)
                    .join(" · ")}
                >
                  {row.accountDescriptor}
                  {row.accountName && (
                    <span className="ml-1.5 text-2xs text-muted-foreground">
                      {row.accountName}
                    </span>
                  )}
                </span>
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
            // the displayName required by EntityRefLink.
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
        add(
          columnHelper.display({
            id: "reviewSuggestion",
            header: "Review",
            cell: ({ row }) =>
              row.original.matchState === "unmatched" &&
              row.original.accountId ? (
                <Link
                  to="/suggestions"
                  search={{
                    family: "statement_transaction",
                    record: `financialAccount:${row.original.accountId}`,
                    date: `${row.original.statementDate}..${row.original.statementDate}`,
                    amount: `${row.original.amount}..${row.original.amount}`,
                  }}
                  className="text-link"
                >
                  Review suggestions
                </Link>
              ) : (
                <NoneValue />
              ),
          }),
        );
      }),
    [],
  );

  const summary = summaryQuery.data;
  const amountTotal =
    summary &&
    (filters.matchState
      ? summary[`${filters.matchState}Amount`]
      : summary.amountTotal);
  const serverTotals = useMemo(
    () =>
      amountTotal === undefined ? undefined : { sums: { amount: amountTotal } },
    [amountTotal],
  );

  const workbench = useChildListWorkbench({
    read: statementRowsPlan,
    filters,
    columns,
    tableState,
    navigation: { kind: "none" },
    serverTotals,
  });
  usePageCount(workbench.isLoading ? undefined : workbench.totalCount);

  return (
    <Stack gap="md">
      <p className="text-sm text-muted-foreground">
        Imported source observations, including multiple rows for the same
        charge. Resolve charges in Suggestions; matching a row does not by
        itself add spending.
      </p>
      <StatementRowSummary
        filters={filters}
        matchState={search.matchState ?? "all"}
        onSelectMatchState={(matchState) => updateFilter({ matchState })}
      />
      <StatementRowFilterBar search={search} onUpdate={updateFilter} />
      <ListWorkbench model={workbench.model} ariaLabel="Statement Rows Table" />
    </Stack>
  );
}
