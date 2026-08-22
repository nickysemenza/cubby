import type { ColumnFiltersState, OnChangeFn } from "@tanstack/react-table";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Filter } from "./filter-bar-core";
import { LedgerFilters } from "./LedgerFilters";
import type { CubbyTable } from "./table-features";

vi.mock("./FilterBar", () => ({
  FilterBar: ({
    filters,
    onChange,
  }: {
    filters: Filter[];
    onChange: (filters: Filter[]) => void;
  }) => (
    <div>
      <output data-testid="ledger-filters">{JSON.stringify(filters)}</output>
      <button
        type="button"
        data-testid="set-trade"
        onClick={() =>
          onChange([
            ...filters.filter((filter) => filter.field !== "trade"),
            {
              id: "ledger-trade",
              field: "trade",
              operator: "is_any_of",
              values: ["electrical"],
            },
          ])
        }
      >
        Set trade
      </button>
      <button
        type="button"
        data-testid="add-name"
        onClick={() =>
          onChange([
            ...filters,
            {
              id: "ledger-name",
              field: "name",
              operator: "contains",
              values: [""],
            },
          ])
        }
      >
        Add name
      </button>
      <button
        type="button"
        data-testid="type-name"
        onClick={() =>
          onChange(
            filters.map((filter) =>
              filter.field === "name"
                ? { ...filter, values: ["lemon"] }
                : filter,
            ),
          )
        }
      >
        Type name
      </button>
      <button
        type="button"
        data-testid="clear-name"
        onClick={() =>
          onChange(
            filters.map((filter) =>
              filter.field === "name" ? { ...filter, values: [""] } : filter,
            ),
          )
        }
      >
        Clear name
      </button>
      <button
        type="button"
        data-testid="remove-name"
        onClick={() =>
          onChange(filters.filter((filter) => filter.field !== "name"))
        }
      >
        Remove name
      </button>
    </div>
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
  const nameColumn = {
    id: "name",
    columnDef: {
      header: "Name",
      meta: {
        filterConfig: {
          filterType: "text",
          placeholder: "Filter by name...",
        },
      },
    },
  };
  const columns = [nameColumn, tradeColumn];
  const table = {
    options: { columns },
    getAllLeafColumns: () => columns,
    get state() {
      return { columnFilters };
    },
    setColumnFilters,
  } as unknown as CubbyTable<{ id: string }>;

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
  it("hydrates filter fields when TanStack materializes leaf columns late", () => {
    const { table } = makeTable();
    const columns = table.getAllLeafColumns();
    let materialized = false;
    const lateTable = {
      ...table,
      getAllLeafColumns: () => (materialized ? columns : []),
    } as CubbyTable<{ id: string }>;
    const { rerender } = render(<LedgerFilters table={lateTable} />);

    expect(screen.queryByTestId("ledger-filters")).not.toBeInTheDocument();

    materialized = true;
    rerender(<LedgerFilters table={lateTable} />);

    expect(screen.getByTestId("ledger-filters")).toBeInTheDocument();
  });

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

    fireEvent.click(screen.getByTestId("set-trade"));

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

  it("keeps a new empty text filter mounted until the user types", () => {
    vi.useFakeTimers();
    const { table, setColumnFilters } = makeTable();
    const { rerender } = render(<LedgerFilters table={table} />);

    fireEvent.click(screen.getByTestId("add-name"));
    expect(screen.getByTestId("ledger-filters")).toHaveTextContent(
      '"field":"name"',
    );

    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(setColumnFilters).not.toHaveBeenCalled();
    expect(screen.getByTestId("ledger-filters")).toHaveTextContent(
      '"field":"name"',
    );

    fireEvent.click(screen.getByTestId("type-name"));
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(setColumnFilters).toHaveBeenCalledTimes(1);
    expect(setColumnFilters).toHaveBeenLastCalledWith([
      { id: "name", value: "lemon" },
    ]);

    rerender(<LedgerFilters table={table} />);
    expect(screen.getByTestId("ledger-filters")).toHaveTextContent(
      '"values":["lemon"]',
    );
  });

  it("preserves an empty text draft while committing an immediate select", () => {
    vi.useFakeTimers();
    const { table, setColumnFilters } = makeTable();
    const { rerender } = render(<LedgerFilters table={table} />);

    fireEvent.click(screen.getByTestId("add-name"));
    fireEvent.click(screen.getByTestId("set-trade"));

    expect(setColumnFilters).toHaveBeenCalledTimes(1);
    expect(setColumnFilters).toHaveBeenLastCalledWith([
      { id: "trade", value: ["electrical"] },
    ]);

    rerender(<LedgerFilters table={table} />);
    expect(screen.getByTestId("ledger-filters")).toHaveTextContent(
      '"field":"name"',
    );
    expect(screen.getByTestId("ledger-filters")).toHaveTextContent(
      '"field":"trade"',
    );

    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(setColumnFilters).toHaveBeenCalledTimes(1);
  });

  it("lets a newer external text filter replace a pending toolbar edit", () => {
    vi.useFakeTimers();
    const { table, setColumnFilters, setExternalFilters } = makeTable();
    const { rerender } = render(<LedgerFilters table={table} />);

    fireEvent.click(screen.getByTestId("add-name"));
    fireEvent.click(screen.getByTestId("type-name"));

    act(() => {
      setExternalFilters([{ id: "name", value: "lime" }]);
      rerender(<LedgerFilters table={table} />);
    });

    expect(screen.getByTestId("ledger-filters")).toHaveTextContent(
      '"values":["lime"]',
    );

    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(setColumnFilters).not.toHaveBeenCalled();
  });

  it("clears a committed text value without removing its draft input", () => {
    vi.useFakeTimers();
    const { table, setColumnFilters, setExternalFilters } = makeTable();
    const { rerender } = render(<LedgerFilters table={table} />);

    act(() => {
      setExternalFilters([{ id: "name", value: "lemon" }]);
      rerender(<LedgerFilters table={table} />);
    });
    fireEvent.click(screen.getByTestId("clear-name"));

    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(setColumnFilters).toHaveBeenCalledTimes(1);
    expect(setColumnFilters).toHaveBeenLastCalledWith([]);

    rerender(<LedgerFilters table={table} />);
    expect(screen.getByTestId("ledger-filters")).toHaveTextContent(
      '"values":[""]',
    );

    fireEvent.click(screen.getByTestId("remove-name"));
    expect(screen.getByTestId("ledger-filters")).not.toHaveTextContent(
      '"field":"name"',
    );
    expect(setColumnFilters).toHaveBeenCalledTimes(1);
  });
});
