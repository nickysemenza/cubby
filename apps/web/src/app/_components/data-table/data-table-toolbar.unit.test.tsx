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

describe("DataTableToolbar query tier", () => {
  it("keeps rest and bulk tiers mounted while disabling both during updates", () => {
    render(
      <DataTableToolbar
        table={table}
        isTransitioning
        actions={<button type="button">Create</button>}
        bulkActionBar={
          <div data-bulk-action-bar>
            <button type="button">Delete selected</button>
          </div>
        }
      />,
    );

    expect(screen.getByText("Updating…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Delete selected" }),
    ).toBeDisabled();
    expect(
      screen
        .getByRole("button", { name: "Create" })
        .closest("[data-query-rest]"),
    ).toBeInTheDocument();
    expect(
      screen
        .getByRole("button", { name: "Delete selected" })
        .closest("[data-query-bulk]"),
    ).toBeInTheDocument();
  });
});
