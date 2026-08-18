import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import TableHeaderLayout from "./TableHeaderLayout";
import { createCubbyColumnHelper, useCubbyTable } from "./table-features";

interface TestRow {
  id: string;
  name: string;
}

const helper = createCubbyColumnHelper<TestRow>();
const columns = helper.columns([
  helper.display({ id: "select", header: "Select" }),
  helper.display({ id: "image", header: "Image" }),
  helper.accessor("name", { id: "name", header: "Name" }),
  helper.display({ id: "actions", header: "Actions" }),
]);

function Harness() {
  const table = useCubbyTable({
    data: [{ id: "row-a", name: "Alpha" }],
    columns,
    getRowId: (row) => row.id,
  });
  return (
    <table>
      <thead>
        <TableHeaderLayout
          table={table}
          styles={{ header: "", sortIcon: "" }}
          isDebugEnabled={false}
        />
      </thead>
    </table>
  );
}

describe("TableHeaderLayout", () => {
  it("does not render reorder grips for Select or Image", () => {
    render(<Harness />);

    expect(
      screen.queryByRole("button", { name: "Reorder select column" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Reorder image column" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Reorder name column" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Reorder actions column" }),
    ).toBeInTheDocument();
  });
});
