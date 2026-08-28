import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DataTableToolbar } from "./data-table-toolbar";
import { useCubbyTable } from "./table-features";

function ToolbarHarness() {
  const table = useCubbyTable({
    data: [],
    columns: [],
    getRowId: (row: { id: string }) => row.id,
  });
  return (
    <DataTableToolbar
      table={table}
      isTransitioning
      showViewOptions={false}
      actions={<button type="button">Create</button>}
      bulkActionBar={
        <div data-bulk-action-bar>
          <button type="button">Delete selected</button>
        </div>
      }
    />
  );
}

describe("DataTableToolbar query tier", () => {
  it("keeps rest and bulk tiers mounted while disabling both during updates", () => {
    render(<ToolbarHarness />);

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
