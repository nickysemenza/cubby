import {
  type ColumnDef,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MobileFilterSheet } from "./MobileFilterSheet";

interface Row {
  id: string;
  name: string;
  trade: string;
}

const COLUMNS: ColumnDef<Row, unknown>[] = [
  {
    id: "name",
    header: "Name",
    accessorKey: "name",
    meta: { filterConfig: { placeholder: "Filter by name..." } },
  },
  {
    id: "trade",
    header: "Trade",
    accessorKey: "trade",
    meta: {
      filterConfig: {
        placeholder: "Filter by trade...",
        filterType: "multiselect" as const,
        options: [
          { value: "drywall", label: "Drywall" },
          { value: "plumbing", label: "Plumbing" },
        ],
      },
    },
  },
  // No filterConfig — must not appear in the sheet.
  { id: "cost", header: "Cost", accessorKey: "id" },
];

function Host({ initialFilters = [] as { id: string; value: unknown }[] }) {
  const table = useReactTable<Row>({
    data: [],
    columns: COLUMNS,
    getCoreRowModel: getCoreRowModel(),
    initialState: { columnFilters: initialFilters },
  });
  return <MobileFilterSheet table={table} />;
}

describe("MobileFilterSheet", () => {
  it("renders a filter trigger when the table has filterable columns", () => {
    render(<Host />);
    expect(screen.getByRole("button", { name: "Filters" })).toBeInTheDocument();
  });

  it("badges the trigger with the active filter count", () => {
    render(<Host initialFilters={[{ id: "trade", value: ["drywall"] }]} />);
    expect(
      screen.getByRole("button", { name: /Filters \(1 active\)/ }),
    ).toBeInTheDocument();
  });

  it("lists exactly the columns that declare a filter", () => {
    render(<Host />);
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));

    // Same controls as the desktop header row, from the same manifest config.
    expect(
      screen.getByPlaceholderText("Filter by name..."),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText("trade")).toBeInTheDocument();
    // `cost` has no filterConfig.
    expect(screen.queryByText("Cost")).not.toBeInTheDocument();
  });

  it("renders nothing when no column is filterable", () => {
    function Bare() {
      const table = useReactTable<Row>({
        data: [],
        columns: [{ id: "cost", header: "Cost", accessorKey: "id" }],
        getCoreRowModel: getCoreRowModel(),
      });
      return <MobileFilterSheet table={table} />;
    }
    const { container } = render(<Bare />);
    expect(container).toBeEmptyDOMElement();
  });
});
