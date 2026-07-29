import type {
  ColumnFiltersState,
  OnChangeFn,
  Table,
} from "@tanstack/react-table";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Filter } from "~/components/reui/filters";
import { LedgerFilters } from "./LedgerFilters";

vi.mock("~/components/reui/filters", () => ({
  Filters: ({
    filters,
    onChange,
  }: {
    filters: Filter<string>[];
    onChange: (filters: Filter<string>[]) => void;
  }) => (
    <button
      type="button"
      data-testid="ledger-filters"
      onClick={() =>
        onChange([
          {
            id: "ledger-trade",
            field: "trade",
            operator: "is_any_of",
            values: ["electrical"],
          },
        ])
      }
    >
      {JSON.stringify(filters)}
    </button>
  ),
}));

function makeTable() {
  let columnFilters: ColumnFiltersState = [];
  const setColumnFilters = vi.fn<OnChangeFn<ColumnFiltersState>>((updater) => {
    columnFilters =
      typeof updater === "function" ? updater(columnFilters) : updater;
  });
  const tradeColumn = {
    id: "trade",
    columnDef: {
      header: "Trade",
      meta: {
        filterConfig: {
          filterType: "multiselect",
          placeholder: "Filter by trade...",
          options: [
            { value: "demo", label: "Demo & Cleanup" },
            { value: "electrical", label: "Electrical & Lighting" },
          ],
        },
      },
    },
  };
  const columns = [tradeColumn];
  const table = {
    options: { columns },
    getAllLeafColumns: () => columns,
    getState: () => ({ columnFilters }),
    setColumnFilters,
  } as unknown as Table<{ id: string }>;

  return {
    table,
    setColumnFilters,
    setExternalFilters: (next: ColumnFiltersState) => {
      columnFilters = next;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("LedgerFilters synchronization", () => {
  it("mirrors external filters without writing its stale debounced draft back", () => {
    vi.useFakeTimers();
    const { table, setColumnFilters, setExternalFilters } = makeTable();
    const { rerender } = render(<LedgerFilters table={table} />);

    act(() => {
      setExternalFilters([{ id: "trade", value: ["demo"] }]);
      rerender(<LedgerFilters table={table} />);
    });

    expect(screen.getByTestId("ledger-filters")).toHaveTextContent(
      '"values":["demo"]',
    );

    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(setColumnFilters).not.toHaveBeenCalled();
  });

  it("writes toolbar filters once and continues mirroring table state", () => {
    vi.useFakeTimers();
    const { table, setColumnFilters } = makeTable();
    const { rerender } = render(<LedgerFilters table={table} />);

    fireEvent.click(screen.getByTestId("ledger-filters"));

    expect(setColumnFilters).toHaveBeenCalledTimes(1);
    expect(setColumnFilters).toHaveBeenLastCalledWith([
      { id: "trade", value: ["electrical"] },
    ]);

    rerender(<LedgerFilters table={table} />);
    expect(screen.getByTestId("ledger-filters")).toHaveTextContent(
      '"values":["electrical"]',
    );

    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(setColumnFilters).toHaveBeenCalledTimes(1);
  });
});
