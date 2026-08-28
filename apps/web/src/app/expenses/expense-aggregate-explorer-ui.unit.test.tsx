import type { ExpenseAnalyzeReadyOut } from "@cubby/schemas/project";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import {
  type ExpenseAggregateExplorerOperations,
  ExpenseAggregateExplorer,
} from "./expense-aggregate-explorer";
import type { ExpenseAnalyzeConfig } from "./expense-analyze-config";
import { expense as expenseOperations } from "./expense.functions";

const aggregate = { actual: 10, committed: 0, credits: 0, net: 10, count: 1 };
const ready = {
  status: "ready",
  rowDimension: "trade",
  columnDimension: "costType",
  comparison: { mode: "none", previousRange: null },
  rows: [
    {
      key: "electrical",
      label: "Electrical",
      filter: { lineKind: "principal", trade: "electrical" },
    },
  ],
  columns: [
    {
      key: "materials",
      label: "Materials",
      filter: { lineKind: "principal", costType: "materials" },
    },
  ],
  cells: [
    {
      rowKey: "electrical",
      columnKey: "materials",
      current: aggregate,
      previous: null,
    },
  ],
  totals: {
    scope: { current: aggregate, previous: null },
    grid: { current: aggregate, previous: null },
  },
  reconciliation: {
    tail: {
      current: { actual: 0, committed: 0, credits: 0, net: 0, count: 0 },
      previous: null,
    },
    causes: {
      adjustments: {
        current: { actual: 0, committed: 0, credits: 0, net: 0, count: 0 },
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

const config: ExpenseAnalyzeConfig = {
  rowDimension: "trade",
  columnDimension: "costType",
  metric: "net",
  comparison: "none",
  projection: "current",
};
const filters = { dateFrom: "2026-08-01", dateTo: "2026-08-15" };

function createBrowserOperations() {
  const copiedValues: string[] = [];
  const downloads: Array<{ filename: string; content: string }> = [];
  return {
    browser: {
      copyText: async (value: string) => {
        copiedValues.push(value);
        return true;
      },
      downloadCsv: (download: { filename: string; content: string }) => {
        downloads.push(download);
      },
    },
    copiedValues,
    downloads,
  };
}

function readyOperations(
  browser: ExpenseAggregateExplorerOperations["browser"],
): ExpenseAggregateExplorerOperations {
  const analyze = expenseOperations.analyze.withTransport(async () => ready);
  return { analyze: analyze.queryOptions, browser };
}

function loadingOperations(
  browser: ExpenseAggregateExplorerOperations["browser"],
): ExpenseAggregateExplorerOperations {
  const analyze = expenseOperations.analyze.withTransport(
    () => new Promise<typeof ready>(() => undefined),
  );
  return { analyze: analyze.queryOptions, browser };
}

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

describe("ExpenseAggregateExplorer controls", () => {
  it("swaps axes through its controlled configuration while loading", async () => {
    const changes: ExpenseAnalyzeConfig[] = [];
    const browserOperations = createBrowserOperations();

    render(
      <ExpenseAggregateExplorer
        filters={filters}
        config={config}
        onConfigChange={(next) => changes.push(next)}
        onOpenLedger={() => undefined}
        operations={loadingOperations(browserOperations.browser)}
      />,
      { wrapper: harness.wrapper },
    );
    fireEvent.click(await screen.findByRole("button", { name: "Swap" }));

    expect(changes).toEqual([
      {
        ...config,
        rowDimension: "costType",
        columnDimension: "trade",
      },
    ]);
    expect(screen.getByRole("button", { name: "Download CSV" })).toBeDisabled();
    expect(
      screen.getByRole("status", { name: "Loading analysis" }),
    ).toBeVisible();
  });

  it("copies the current URL and downloads only the complete ready result", async () => {
    const browserOperations = createBrowserOperations();

    render(
      <ExpenseAggregateExplorer
        filters={filters}
        config={config}
        onConfigChange={() => undefined}
        onOpenLedger={() => undefined}
        operations={readyOperations(browserOperations.browser)}
      />,
      { wrapper: harness.wrapper },
    );

    fireEvent.click(await screen.findByRole("button", { name: "Copy link" }));
    await waitFor(() =>
      expect(browserOperations.copiedValues).toEqual([window.location.href]),
    );

    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    expect(browserOperations.downloads).toHaveLength(1);
    expect(browserOperations.downloads[0]?.filename).toMatch(
      /expenses-analysis/,
    );
    expect(browserOperations.downloads[0]?.content).toContain("Electrical");
  });
});
