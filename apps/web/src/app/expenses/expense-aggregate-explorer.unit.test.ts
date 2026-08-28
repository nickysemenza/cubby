import type { ExpenseAnalyzeReadyOut } from "@cubby/schemas/project";
import { describe, expect, it } from "vitest";

import {
  buildExpenseAnalyzeTableRows,
  canCompareExpenseAnalysis,
  expenseAnalyzeDrilldownFilter,
  expenseAnalyzeGridTotalFilter,
  formatExpenseAnalyzeValue,
  initialExpenseAnalyzeSorting,
} from "./expense-aggregate-explorer";

const ready = {
  status: "ready",
  rowDimension: "trade",
  columnDimension: null,
  comparison: { mode: "none", previousRange: null },
  rows: [
    {
      key: "electrical",
      label: "Electrical & Lighting",
      filter: { lineKind: "principal", trade: "electrical" },
    },
  ],
  columns: [],
  cells: [
    {
      rowKey: "electrical",
      columnKey: null,
      current: { actual: 140, committed: 50, credits: 10, net: 180, count: 4 },
      previous: null,
    },
  ],
  totals: {
    scope: {
      current: { actual: 150, committed: 50, credits: 10, net: 190, count: 5 },
      previous: null,
    },
    grid: {
      current: { actual: 140, committed: 50, credits: 10, net: 180, count: 4 },
      previous: null,
    },
  },
  reconciliation: {
    tail: {
      current: { actual: 10, committed: 0, credits: 0, net: 10, count: 1 },
      previous: null,
    },
    causes: {
      adjustments: {
        current: { actual: 10, committed: 0, credits: 0, net: 10, count: 1 },
        previous: null,
      },
      unattributedProject: {
        current: { actual: 0, committed: 0, credits: 0, net: 0, count: 0 },
        previous: null,
      },
      unattributedVendor: {
        current: { actual: 0, committed: 0, credits: 0, net: 0, count: 0 },
        previous: null,
      },
    },
  },
} as const satisfies ExpenseAnalyzeReadyOut;

describe("ExpenseAggregateExplorer", () => {
  it("projects complete server buckets into one-dimensional rows without inventing a tail bucket", () => {
    expect(buildExpenseAnalyzeTableRows(ready)).toEqual([
      {
        id: "electrical",
        label: "Electrical & Lighting",
        filter: { lineKind: "principal", trade: "electrical" },
        current: {
          actual: 140,
          committed: 50,
          credits: 10,
          net: 180,
          count: 4,
        },
        previous: null,
      },
    ]);
  });

  it("only enables prior-period comparison for an explicit non-month range", () => {
    expect(
      canCompareExpenseAnalysis(
        { dateFrom: "2026-08-01", dateTo: "2026-08-15" },
        "trade",
        "costType",
      ),
    ).toBe(true);
    expect(
      canCompareExpenseAnalysis(
        { dateFrom: "2026-08-01", dateTo: "2026-08-15" },
        "month",
        null,
      ),
    ).toBe(false);
    expect(
      canCompareExpenseAnalysis({ dateFrom: "2026-08-01" }, "trade", null),
    ).toBe(false);
  });

  it("uses honest zero-baseline comparison labels", () => {
    expect(formatExpenseAnalyzeValue(10, 0, "net", "percent")).toBe("New");
    expect(formatExpenseAnalyzeValue(0, 0, "net", "percent")).toBe("—");
    expect(formatExpenseAnalyzeValue(120, 100, "net", "percent")).toBe("+20%");
  });

  it("uses a valid initial sort column for each table shape", () => {
    expect(initialExpenseAnalyzeSorting("none")).toEqual([
      { id: "net", desc: true },
    ]);
    expect(initialExpenseAnalyzeSorting("previousPeriod")).toEqual([
      { id: "current", desc: true },
    ]);
  });

  it("drills into exact current or previous populations, not derived deltas", () => {
    const compared = {
      ...ready,
      comparison: {
        mode: "previousPeriod",
        previousRange: { dateFrom: "2026-07-17", dateTo: "2026-07-31" },
      },
    } satisfies ExpenseAnalyzeReadyOut;
    const axis = { trade: "electrical" };
    expect(expenseAnalyzeDrilldownFilter(compared, "current", axis)).toEqual(
      axis,
    );
    expect(expenseAnalyzeDrilldownFilter(compared, "previous", axis)).toEqual({
      trade: "electrical",
      dateFrom: "2026-07-17",
      dateTo: "2026-07-31",
    });
    expect(expenseAnalyzeDrilldownFilter(compared, "delta", axis)).toBeNull();
    expect(expenseAnalyzeDrilldownFilter(compared, "percent", axis)).toBeNull();
  });

  it("only exposes exact grid-total populations to Ledger drilldown", () => {
    expect(expenseAnalyzeGridTotalFilter(ready)).toEqual({
      lineKind: "principal",
    });
    expect(
      expenseAnalyzeGridTotalFilter({
        ...ready,
        rowDimension: "project",
      }),
    ).toBeNull();
    const byMonth = {
      ...ready,
      rowDimension: "month",
      rows: [
        {
          key: "2026-06",
          label: "2026-06",
          filter: { dateFrom: "2026-06-01", dateTo: "2026-06-30" },
        },
        {
          key: "2026-08",
          label: "2026-08",
          filter: { dateFrom: "2026-08-01", dateTo: "2026-08-31" },
        },
      ],
    } satisfies ExpenseAnalyzeReadyOut;
    expect(expenseAnalyzeGridTotalFilter(byMonth)).toEqual({
      dateFrom: "2026-06-01",
      dateTo: "2026-08-31",
    });
    expect(
      expenseAnalyzeGridTotalFilter(byMonth, {
        dateFrom: "2026-06-15",
        dateTo: "2026-08-10",
      }),
    ).toEqual({});
  });
});
