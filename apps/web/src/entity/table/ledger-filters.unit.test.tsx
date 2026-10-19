import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ColumnFiltersState } from "@tanstack/react-table";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FilterFieldConfig } from "../../ui/data-table/filter-bar-core";
import {
  barFiltersToFilterState,
  filterStateToBarFilters,
} from "../../ui/data-table/filter-bar-core";
import {
  createCubbyColumnHelper,
  useCubbyTable,
} from "../../ui/data-table/table-features";
import { requestColumnFilterEdit } from "../../ui/data-table/table-meta";
import { useFilterBarDraft } from "../../ui/data-table/use-filter-bar-draft";
import { LedgerFilters } from "./ledger-filters";

type LedgerRow = { id: string; name: string; trade: string };

const helper = createCubbyColumnHelper<LedgerRow>();
const columns = helper.columns([
  helper.accessor("name", {
    header: "Name",
    meta: { filterConfig: { placeholder: "Filter by name..." } },
  }),
  helper.accessor("trade", {
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
  }),
]);

function LedgerFiltersHarness({
  onTable,
}: {
  onTable?: (table: ReturnType<typeof useCubbyTable<LedgerRow>>) => void;
}) {
  const table = useCubbyTable({
    data: [],
    columns,
    getRowId: (row) => row.id,
  });
  onTable?.(table);

  return (
    <>
      <LedgerFilters entity="task" table={table} />
      <output data-testid="column-filters">
        {JSON.stringify(table.state.columnFilters)}
      </output>
    </>
  );
}

function PrimarySearchHarness() {
  const table = useCubbyTable({
    data: [],
    // Regression: generic entity search is declared metadata, not an accident
    // of a table mounting a literal `name` column.
    columns: helper.columns([
      helper.accessor("trade", {
        header: "Trade",
        meta: { filterConfig: { placeholder: "Filter by trade..." } },
      }),
    ]),
    getRowId: (row) => row.id,
  });
  return (
    <>
      <LedgerFilters table={table} entity="task" />
      <output data-testid="primary-column-filters">
        {JSON.stringify(table.state.columnFilters)}
      </output>
    </>
  );
}

// Facet and view-count queries are disabled outside a page list, but their
// hooks still need a client.
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>
    {children}
  </QueryClientProvider>
);

describe("LedgerFilters", () => {
  it("writes a picked multiselect value to the table without an Apply step", async () => {
    render(<LedgerFiltersHarness />, { wrapper });

    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    fireEvent.click(await screen.findByRole("button", { name: "Trade" }));
    fireEvent.click(
      await screen.findByRole("option", { name: "Electrical & Lighting" }),
    );

    // Live apply commits after the draft debounce.
    expect(
      await screen.findByText('[{"id":"trade","value":["electrical"]}]'),
    ).toBeInTheDocument();
  });

  it("opens the panel on a column header's filter request", async () => {
    let table: ReturnType<typeof useCubbyTable<LedgerRow>> | undefined;
    render(<LedgerFiltersHarness onTable={(next) => (table = next)} />, {
      wrapper,
    });

    act(() => requestColumnFilterEdit(table!, "trade"));

    expect(
      await screen.findByRole("button", { name: "Trade", expanded: true }),
    ).toBeInTheDocument();
  });

  it("uses declared primary search and keeps the title field in the panel", async () => {
    render(<LedgerFiltersHarness />, { wrapper });

    const search = screen.getByRole("textbox", {
      name: "Search tasks or shortcode",
    });
    expect(search).toHaveValue("");
    expect(screen.queryByRole("button", { name: /^Name/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    expect(await screen.findByRole("button", { name: "Name" })).toBeVisible();
    expect(screen.getByTestId("column-filters")).toHaveTextContent("[]");
  });

  it("renders the declared primary search even when no name column is mounted", () => {
    render(<PrimarySearchHarness />, { wrapper });

    const search = screen.getByRole("textbox", {
      name: "Search tasks or shortcode",
    });
    expect(search).toHaveValue("");
  });
});

type TestField = FilterFieldConfig & {
  key: string;
  type: "text" | "select" | "multiselect";
};

const adapterFields: TestField[] = [
  { key: "name", label: "Name", type: "text" },
  { key: "status", label: "Status", type: "multiselect" },
  { key: "project", label: "Project", type: "select" },
];

describe("deferred filter ownership", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps a typed search through old-owner renders and delayed acknowledgements without masking an external reset", async () => {
    vi.useFakeTimers();
    const filters = (value: string) =>
      filterStateToBarFilters([{ id: "name", value }], adapterFields);
    const writes: ColumnFiltersState[] = [];
    const commit = (value: ColumnFiltersState) => writes.push(value);
    const { result, rerender } = renderHook(
      ({ value }) =>
        useFilterBarDraft({
          externalFilters: filters(value),
          fields: adapterFields,
          commit,
        }),
      { initialProps: { value: "all" } },
    );
    // The table accepts writes in startTransition. A foreground render can
    // still carry its old filters; a later acknowledgement can also arrive
    // after the user has started typing their next search.
    act(() => result.current.handleChange(filters("credit")));
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(writes).toEqual([[{ id: "name", value: "credit" }]]);
    rerender({ value: "all" });
    expect(result.current.draftFilters).toEqual(filters("credit"));
    expect(writes).toHaveLength(1);

    act(() => result.current.handleChange(filters("zero")));
    rerender({ value: "credit" });
    expect(result.current.draftFilters).toEqual(filters("zero"));
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(writes).toEqual([
      [{ id: "name", value: "credit" }],
      [{ id: "name", value: "zero" }],
    ]);

    rerender({ value: "saved view" });
    expect(result.current.draftFilters).toEqual(filters("saved view"));
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(writes).toHaveLength(2);
  });
});

describe("LedgerFilters adapters", () => {
  it("preserves scalar and multiselect table state", () => {
    const tableFilters = [
      { id: "name", value: "sink" },
      { id: "status", value: ["blocked", "in_progress"] },
      { id: "project", value: "project-1" },
    ];

    const ledger = filterStateToBarFilters(tableFilters, adapterFields);

    expect(
      ledger.map(({ field, operator, values }) => ({
        field,
        operator,
        values,
      })),
    ).toEqual([
      { field: "name", operator: "contains", values: ["sink"] },
      {
        field: "status",
        operator: "is_any_of",
        values: ["blocked", "in_progress"],
      },
      { field: "project", operator: "is", values: ["project-1"] },
    ]);
    expect(barFiltersToFilterState(ledger, adapterFields)).toEqual(
      tableFilters,
    );
  });

  it("drops empty values and unknown fields", () => {
    expect(
      barFiltersToFilterState(
        [
          {
            id: "empty",
            field: "name",
            operator: "contains",
            values: [""],
          },
          {
            id: "unknown",
            field: "missing",
            operator: "is",
            values: ["value"],
          },
        ],
        adapterFields,
      ),
    ).toEqual([]);
  });
});
