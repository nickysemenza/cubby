import type { ExpenseAnalyzeReadyOut } from "@cubby/schemas/project";
import { describe, expect, it } from "vitest";

import {
  expenseAnalyzeCsv,
  expenseAnalyzeCsvFilename,
} from "./expense-analyze-csv";

const aggregate = (net: number, count = 1) => ({
  actual: net,
  committed: 0,
  credits: 0,
  net,
  count,
});

const compared = {
  status: "ready",
  rowDimension: "trade",
  columnDimension: "costType",
  comparison: {
    mode: "previousPeriod",
    previousRange: { dateFrom: "2026-07-17", dateTo: "2026-07-31" },
  },
  rows: [
    {
      key: "electrical",
      label: 'Electrical, "Lighting"',
      filter: { lineKind: "principal", trade: "electrical" },
    },
    {
      key: "plumbing",
      label: "Plumbing",
      filter: { lineKind: "principal", trade: "plumbing" },
    },
  ],
  columns: [
    {
      key: "materials",
      label: "Materials\nand fixtures",
      filter: { lineKind: "principal", costType: "materials" },
    },
    {
      key: "services",
      label: "Services",
      filter: { lineKind: "principal", costType: "services" },
    },
  ],
  cells: [
    {
      rowKey: "electrical",
      columnKey: "materials",
      current: aggregate(100),
      previous: aggregate(80),
    },
  ],
  totals: {
    scope: { current: aggregate(110, 2), previous: aggregate(90, 2) },
    grid: { current: aggregate(100), previous: aggregate(80) },
  },
  reconciliation: {
    tail: { current: aggregate(10), previous: aggregate(10) },
    causes: {
      adjustments: { current: aggregate(10), previous: aggregate(10) },
      unattributedProject: {
        current: aggregate(0, 0),
        previous: aggregate(0, 0),
      },
      unattributedVendor: {
        current: aggregate(0, 0),
        previous: aggregate(0, 0),
      },
    },
  },
} as const satisfies ExpenseAnalyzeReadyOut;

describe("expense Analyze CSV", () => {
  it("exports complete periods, totals, additive reconciliation, and applicable explanations", () => {
    const csv = expenseAnalyzeCsv(compared);

    expect(csv).toContain(
      'bucket,current,trade,electrical,"Electrical, ""Lighting""",costType,materials,"Materials\nand fixtures",100,0,0,100,1',
    );
    expect(csv).toContain(
      'bucket,previous,trade,electrical,"Electrical, ""Lighting""",costType,materials,"Materials\nand fixtures",80,0,0,80,1',
    );
    expect(csv).toContain(
      "scope_total,current,trade,,,costType,,,110,0,0,110,2",
    );
    expect(csv).toContain(
      "reconciliation_tail,previous,trade,,,costType,,,10,0,0,10,1",
    );
    expect(csv).toContain(
      "adjustments_explanation,current,trade,,,costType,,,10,0,0,10,1",
    );
    expect(csv).not.toContain("unattributed_project_explanation");
    expect(csv).not.toContain("delta");
    expect(csv).not.toContain("Unknown");
    expect(
      csv.split("\r\n").filter((row) => row.startsWith("bucket,current,")),
    ).toHaveLength(1);
  });

  it("exports sparse one-dimensional buckets and their applicable explanation", () => {
    const byProject = {
      ...compared,
      rowDimension: "project",
      columnDimension: null,
      comparison: { mode: "none", previousRange: null },
      columns: [],
      cells: [
        {
          ...compared.cells[0],
          rowKey: "PRJ-1234",
          columnKey: null,
          previous: null,
        },
      ],
      rows: [
        {
          key: "PRJ-1234",
          label: "Kitchen, phase 2",
          filter: { project: "PRJ-1234" },
        },
      ],
      reconciliation: {
        ...compared.reconciliation,
        causes: {
          ...compared.reconciliation.causes,
          unattributedProject: {
            current: aggregate(10),
            previous: null,
          },
        },
      },
    } satisfies ExpenseAnalyzeReadyOut;

    const csv = expenseAnalyzeCsv(byProject);
    expect(csv).toContain(
      'bucket,current,project,PRJ-1234,"Kitchen, phase 2",,,,100,0,0,100,1',
    );
    expect(csv).toContain(
      "unattributed_project_explanation,current,project,,,,,,10,0,0,10,1",
    );
    expect(csv).not.toContain("bucket,previous");
  });

  it("uses a stable dimensional filename", () => {
    expect(expenseAnalyzeCsvFilename(compared, new Date(2026, 7, 18))).toBe(
      "expenses-analysis-trade-by-costType-2026-08-18.csv",
    );
  });
});
