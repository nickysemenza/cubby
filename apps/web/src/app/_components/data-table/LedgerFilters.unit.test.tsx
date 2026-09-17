import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { FilterFieldConfig } from "./filter-bar-core";
import {
  barFiltersToFilterState,
  filterStateToBarFilters,
} from "./filter-bar-core";
import { LedgerFilters } from "./LedgerFilters";
import { createCubbyColumnHelper, useCubbyTable } from "./table-features";

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

function LedgerFiltersHarness() {
  const table = useCubbyTable({
    data: [],
    columns,
    getRowId: (row) => row.id,
  });

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

describe("LedgerFilters", () => {
  it("writes a selected multiselect filter through the checklist's Apply", async () => {
    render(<LedgerFiltersHarness />);

    fireEvent.click(screen.getByRole("button", { name: "Trade: any" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Electrical & Lighting" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(screen.getByTestId("column-filters")).toHaveTextContent(
      '[{"id":"trade","value":["electrical"]}]',
    );
  });

  it("uses declared primary search while keeping the title field as a narrow chip", () => {
    render(<LedgerFiltersHarness />);

    const search = screen.getByRole("textbox", {
      name: "Search tasks or shortcode",
    });
    expect(search).toHaveValue("");
    expect(screen.getByRole("button", { name: "Name: any" })).toBeVisible();
    expect(screen.getByTestId("column-filters")).toHaveTextContent("[]");
  });

  it("renders the declared primary search even when no name column is mounted", () => {
    render(<PrimarySearchHarness />);

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
