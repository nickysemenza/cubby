import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("./DataTableViews", () => ({ DataTableViews: () => null }));
vi.mock("./data-table-view-options", () => ({
  DataTableViewOptions: () => null,
}));
vi.mock("./LedgerFilters", () => ({ LedgerFilters: () => null }));

import { DataTableToolbar } from "./data-table-toolbar";
import type { CubbyTable as Table } from "./table-features";

const table = {} as Table<{ id: string }>;

describe("DataTableToolbar transition state", () => {
  it("announces an update and disables stale-row actions", () => {
    render(
      <DataTableToolbar
        table={table}
        isTransitioning
        actions={<button type="button">Create</button>}
        bulkActionBar={<button type="button">Delete selected</button>}
      />,
    );

    expect(screen.getByText("Updating…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Delete selected" }),
    ).toBeDisabled();
  });
});
