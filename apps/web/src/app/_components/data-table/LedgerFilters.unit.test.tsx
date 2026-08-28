import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

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
      <LedgerFilters table={table} />
      <output data-testid="column-filters">
        {JSON.stringify(table.state.columnFilters)}
      </output>
    </>
  );
}

describe("LedgerFilters", () => {
  it("writes a selected multiselect filter through the real table and filter bar", async () => {
    render(<LedgerFiltersHarness />);

    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    fireEvent.click(screen.getByRole("button", { name: "Trade" }));
    fireEvent.click(screen.getByRole("button", { name: "Trade: Choose…" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Filter Trade" }));
    fireEvent.click(
      await screen.findByRole("option", { name: "Electrical & Lighting" }),
    );

    expect(screen.getByTestId("column-filters")).toHaveTextContent(
      '[{"id":"trade","value":["electrical"]}]',
    );
  });

  it("keeps an empty text chip until the user supplies a value", () => {
    render(<LedgerFiltersHarness />);

    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    fireEvent.click(screen.getByRole("button", { name: "Name" }));

    expect(screen.getByRole("button", { name: "Name: Choose…" })).toBeVisible();
    expect(screen.getByTestId("column-filters")).toHaveTextContent("[]");
  });
});
