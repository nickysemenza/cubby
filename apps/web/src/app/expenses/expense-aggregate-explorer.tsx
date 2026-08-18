import {
  type CostType,
  type ExpenseAnalyticsOut,
  type ExpenseAnalyticsSummary,
  TRADE_LABELS,
} from "@cubby/schemas/project";
import type { SortingState } from "@tanstack/react-table";
import { useId, useMemo, useState } from "react";
import RTable from "~/app/_components/data-table/Table";
import {
  createCubbyColumnHelper,
  useCubbyTable,
} from "~/app/_components/data-table/table-features";
import { useCubbyTableLayout } from "~/app/_components/data-table/table-layout";
import { Row } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { NativeSelect } from "~/components/ui/native-select";
import { formatCurrency } from "~/lib/utils";
import { costTypeLabels } from "./expense-options";

export type ExpenseExplorerDimension =
  | "trade"
  | "costType"
  | "month"
  | "project"
  | "vendor"
  | "tradeCost";

type Metrics = Pick<
  ExpenseAnalyticsSummary,
  "actual" | "committed" | "credits" | "net" | "count"
>;

export interface ExpenseExplorerRow extends Metrics {
  id: string;
  label: string;
  ledgerFilter: {
    trade?: string;
    costType?: string;
    project?: string;
    vendor?: string;
    dateFrom?: string;
    dateTo?: string;
  };
}

export interface ExpenseExplorerModel {
  rows: ExpenseExplorerRow[];
  tail: Metrics & { label: string };
}

const sumRows = (rows: ExpenseExplorerRow[]): Metrics =>
  rows.reduce<Metrics>(
    (total, row) => ({
      actual: total.actual + row.actual,
      committed: total.committed + row.committed,
      credits: total.credits + row.credits,
      net: total.net + row.net,
      count: total.count + row.count,
    }),
    { actual: 0, committed: 0, credits: 0, net: 0, count: 0 },
  );

function endOfMonth(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  const day = new Date(Date.UTC(year!, monthNumber!, 0)).getUTCDate();
  return `${month}-${String(day).padStart(2, "0")}`;
}

function monthLabel(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Intl.DateTimeFormat(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year!, monthNumber! - 1, 1)));
}

export function buildExpenseExplorerModel(
  analytics: ExpenseAnalyticsOut,
  dimension: ExpenseExplorerDimension,
): ExpenseExplorerModel {
  const rows: ExpenseExplorerRow[] =
    dimension === "trade"
      ? analytics.byTrade.map((row) => ({
          ...row,
          id: row.trade,
          label: TRADE_LABELS[row.trade],
          ledgerFilter: { trade: row.trade },
        }))
      : dimension === "costType"
        ? analytics.byCostType.map((row) => ({
            ...row,
            id: row.costType,
            label: costTypeLabels[row.costType],
            ledgerFilter: { costType: row.costType },
          }))
        : dimension === "month"
          ? analytics.monthly.map((row) => ({
              ...row,
              id: row.month,
              label: monthLabel(row.month),
              ledgerFilter: {
                dateFrom: `${row.month}-01`,
                dateTo: endOfMonth(row.month),
              },
            }))
          : dimension === "project"
            ? analytics.byProject.map((row) => ({
                ...row,
                id: row.projectId,
                label: row.projectName,
                ledgerFilter: { project: row.projectId },
              }))
            : dimension === "vendor"
              ? analytics.byVendor.map((row) => ({
                  ...row,
                  id: row.vendorId,
                  label: row.vendorName,
                  ledgerFilter: { vendor: row.vendorId },
                }))
              : analytics.tradeCostMatrix.map((row) => ({
                  ...row,
                  id: `${row.trade}:${row.costType}`,
                  label: `${TRADE_LABELS[row.trade]} · ${costTypeLabels[row.costType as CostType]}`,
                  ledgerFilter: {
                    trade: row.trade,
                    costType: row.costType,
                  },
                }));

  const classified = sumRows(rows);
  const total = analytics.summary;
  const label =
    dimension === "project"
      ? "Unattributed to a project"
      : dimension === "vendor"
        ? "Unattributed to a vendor"
        : dimension === "month"
          ? "Undated spend"
          : "Purchase adjustments";
  return {
    rows,
    tail: {
      label,
      actual: total.actual - classified.actual,
      committed: total.committed - classified.committed,
      credits: total.credits - classified.credits,
      net: total.net - classified.net,
      count: total.count - classified.count,
    },
  };
}

const helper = createCubbyColumnHelper<ExpenseExplorerRow>();

export function ExpenseAggregateExplorer({
  analytics,
  onOpenLedger,
}: {
  analytics: ExpenseAnalyticsOut;
  onOpenLedger: (filter: ExpenseExplorerRow["ledgerFilter"]) => void;
}) {
  const [dimension, setDimension] = useState<ExpenseExplorerDimension>("trade");
  const [sorting, setSorting] = useState<SortingState>([
    { id: "net", desc: true },
  ]);
  const groupById = useId();
  const model = useMemo(
    () => buildExpenseExplorerModel(analytics, dimension),
    [analytics, dimension],
  );
  const columns = useMemo(
    () =>
      helper.columns([
        helper.accessor("label", {
          header: "Label",
          size: 260,
          minSize: 160,
          footer: () => model.tail.label,
          enableCellSelection: false,
        }),
        ...(
          [
            ["actual", "Actual"],
            ["committed", "Committed"],
            ["credits", "Credits"],
            ["net", "Net"],
          ] as const
        ).map(([accessor, header]) =>
          helper.accessor(accessor, {
            header,
            size: 128,
            minSize: 104,
            meta: { numeric: true, mono: true },
            cell: (info) => formatCurrency(info.getValue()),
            footer: () => formatCurrency(model.tail[accessor]),
            enableCellSelection: false,
          }),
        ),
        helper.accessor("count", {
          header: "Count",
          size: 88,
          minSize: 72,
          meta: { numeric: true, mono: true },
          cell: (info) => info.getValue().toLocaleString(),
          footer: () => model.tail.count.toLocaleString(),
          enableCellSelection: false,
        }),
        helper.display({
          id: "actions",
          header: "",
          size: 88,
          minSize: 88,
          enableHiding: false,
          enableCellSelection: false,
          cell: ({ row }) => (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onOpenLedger(row.original.ledgerFilter)}
            >
              Ledger
            </Button>
          ),
        }),
      ]),
    [model.tail, onOpenLedger],
  );
  const layout = useCubbyTableLayout({
    key: "expense:aggregate-explorer",
    columns,
  });
  const table = useCubbyTable({
    data: model.rows,
    columns: layout.columns,
    atoms: layout.atoms,
    meta: { defaultLayout: layout.defaultLayout },
    getRowId: (row) => row.id,
    state: { sorting },
    onSortingChange: setSorting,
    enableCellSelection: false,
    initialState: { pagination: { pageIndex: 0, pageSize: 500 } },
  });

  return (
    <RTable
      table={table}
      embedded
      showColumnMenu
      ariaLabel="Expense aggregate explorer"
      emptyState="No aggregate buckets match the current ledger filters."
      additionalToolbarContent={
        <Row align="center" gap="xs">
          <label htmlFor={groupById} className="text-xs">
            Group by
          </label>
          <NativeSelect
            id={groupById}
            value={dimension}
            onChange={(event) =>
              setDimension(event.target.value as ExpenseExplorerDimension)
            }
          >
            <option value="trade">Trade</option>
            <option value="costType">Cost category</option>
            <option value="month">Month</option>
            <option value="project">Project</option>
            <option value="vendor">Vendor</option>
            <option value="tradeCost">Trade × Cost Type</option>
          </NativeSelect>
        </Row>
      }
    />
  );
}
