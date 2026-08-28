import type {
  ExpenseAnalyzeAggregate,
  ExpenseAnalyzeReadyOut,
} from "@cubby/schemas/project";
import { format } from "date-fns";

type ExportPeriod = "current" | "previous";
type ExportRecordType =
  | "bucket"
  | "scope_total"
  | "grid_total"
  | "reconciliation_tail"
  | "adjustments_explanation"
  | "unattributed_project_explanation"
  | "unattributed_vendor_explanation";

const HEADER = [
  "record_type",
  "period",
  "row_dimension",
  "row_key",
  "row_label",
  "column_dimension",
  "column_key",
  "column_label",
  "actual",
  "committed",
  "credits",
  "net",
  "count",
] as const;

const csvCell = (value: string | number) => {
  const text = String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

interface CsvRowIdentity {
  recordType: ExportRecordType;
  period: ExportPeriod;
  rowKey?: string;
  rowLabel?: string;
  columnKey?: string;
  columnLabel?: string;
}

function csvRow(
  data: ExpenseAnalyzeReadyOut,
  identity: CsvRowIdentity,
  value: ExpenseAnalyzeAggregate,
) {
  return [
    identity.recordType,
    identity.period,
    data.rowDimension,
    identity.rowKey ?? "",
    identity.rowLabel ?? "",
    data.columnDimension ?? "",
    identity.columnKey ?? "",
    identity.columnLabel ?? "",
    value.actual,
    value.committed,
    value.credits,
    value.net,
    value.count,
  ].map(csvCell);
}

function pairRows(
  data: ExpenseAnalyzeReadyOut,
  recordType: ExportRecordType,
  pair: {
    current: ExpenseAnalyzeAggregate;
    previous: ExpenseAnalyzeAggregate | null;
  },
) {
  const rows = [csvRow(data, { recordType, period: "current" }, pair.current)];
  if (pair.previous) {
    rows.push(csvRow(data, { recordType, period: "previous" }, pair.previous));
  }
  return rows;
}

/**
 * Complete, machine-friendly export of the bounded server result. Explanatory
 * causes are deliberately separate records because they may overlap and must
 * never be summed as though they were reconciliation buckets.
 */
export function expenseAnalyzeCsv(data: ExpenseAnalyzeReadyOut): string {
  const rows: string[][] = [HEADER.map(csvCell)];
  const rowByKey = new Map(data.rows.map((row) => [row.key, row]));
  const columnByKey = new Map(
    data.columns.map((column) => [column.key, column]),
  );

  for (const cell of data.cells) {
    const row = rowByKey.get(cell.rowKey);
    const column = cell.columnKey ? columnByKey.get(cell.columnKey) : undefined;
    const identity = {
      recordType: "bucket" as const,
      rowKey: cell.rowKey,
      rowLabel: row?.label ?? cell.rowKey,
      columnKey: cell.columnKey ?? undefined,
      columnLabel: column?.label,
    };
    rows.push(csvRow(data, { ...identity, period: "current" }, cell.current));
    if (cell.previous) {
      rows.push(
        csvRow(data, { ...identity, period: "previous" }, cell.previous),
      );
    }
  }

  rows.push(...pairRows(data, "scope_total", data.totals.scope));
  rows.push(...pairRows(data, "grid_total", data.totals.grid));
  rows.push(...pairRows(data, "reconciliation_tail", data.reconciliation.tail));

  const principalAxis =
    data.rowDimension === "trade" ||
    data.rowDimension === "costType" ||
    data.columnDimension === "trade" ||
    data.columnDimension === "costType";
  if (principalAxis) {
    rows.push(
      ...pairRows(
        data,
        "adjustments_explanation",
        data.reconciliation.causes.adjustments,
      ),
    );
  }
  if (data.rowDimension === "project") {
    rows.push(
      ...pairRows(
        data,
        "unattributed_project_explanation",
        data.reconciliation.causes.unattributedProject,
      ),
    );
  }
  if (data.rowDimension === "vendor") {
    rows.push(
      ...pairRows(
        data,
        "unattributed_vendor_explanation",
        data.reconciliation.causes.unattributedVendor,
      ),
    );
  }

  return `${rows.map((row) => row.join(",")).join("\r\n")}\r\n`;
}

export function expenseAnalyzeCsvFilename(
  data: Pick<ExpenseAnalyzeReadyOut, "rowDimension" | "columnDimension">,
  date = new Date(),
) {
  const layout = data.columnDimension
    ? `${data.rowDimension}-by-${data.columnDimension}`
    : data.rowDimension;
  return `expenses-analysis-${layout}-${format(date, "yyyy-MM-dd")}.csv`;
}
