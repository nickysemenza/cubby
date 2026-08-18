import type { ExpenseAnalyzeReadyOut } from "@cubby/schemas/project";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExpenseAnalyzeConfig } from "./expense-analyze-config";

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  copyText: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({ useQuery: mocks.useQuery }));
vi.mock("~/integrations/trpc/react", () => ({
  useTRPC: () => ({
    expense: {
      analyze: {
        queryOptions: (input: unknown) => ({
          queryKey: ["expense", "analyze", input],
        }),
      },
    },
  }),
}));
vi.mock("~/lib/clipboard", () => ({ copyText: mocks.copyText }));
vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

import { ExpenseAggregateExplorer } from "./expense-aggregate-explorer";

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

afterEach(() => {
  vi.restoreAllMocks();
  mocks.useQuery.mockReset();
  mocks.copyText.mockReset();
  mocks.toastSuccess.mockReset();
  mocks.toastError.mockReset();
});

describe("ExpenseAggregateExplorer controls", () => {
  it("swaps axes through its controlled configuration while loading", () => {
    mocks.useQuery.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      refetch: vi.fn(),
    });
    const onConfigChange = vi.fn();

    render(
      <ExpenseAggregateExplorer
        filters={filters}
        config={config}
        onConfigChange={onConfigChange}
        onOpenLedger={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Swap" }));

    expect(onConfigChange).toHaveBeenCalledWith({
      ...config,
      rowDimension: "costType",
      columnDimension: "trade",
    });
    expect(screen.getByRole("button", { name: "Download CSV" })).toBeDisabled();
    expect(
      screen.getByRole("status", { name: "Loading analysis" }),
    ).toBeVisible();
  });

  it("copies the current URL and downloads only the complete ready result", async () => {
    mocks.useQuery.mockReturnValue({
      data: ready,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    mocks.copyText.mockResolvedValue(true);
    window.history.replaceState(
      {},
      "",
      "/expenses?view=analytics&analyzeColumns=costType",
    );
    const createObjectUrl = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:expense-analysis");
    const revokeObjectUrl = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => undefined);
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    render(
      <ExpenseAggregateExplorer
        filters={filters}
        config={config}
        onConfigChange={vi.fn()}
        onOpenLedger={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() =>
      expect(mocks.copyText).toHaveBeenCalledWith(window.location.href),
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Analysis link copied");

    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    expect(createObjectUrl).toHaveBeenCalledWith(expect.any(Blob));
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:expense-analysis");
  });
});
