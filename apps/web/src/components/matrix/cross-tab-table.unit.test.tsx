import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CrossTabTable, type CrossTabTableProps } from "./cross-tab-table";
import type { CrossTabColumn } from "./group-columns";
import { EMPTY_MARK } from "./matrix-chrome";

type Row = { name: string; values: Record<string, number | undefined> };

const columns: CrossTabColumn<string>[] = [
  { key: "c1", data: "One", groupKey: "g1" },
  { key: "c2", data: "Two", groupKey: "g1" },
  { key: "c3", data: "Three", groupKey: "g2" },
];

const rows = [
  { key: "flour", data: { name: "flour", values: { c1: 100, c3: 50 } } },
  { key: "salt", data: { name: "salt", values: { c2: 5 } } },
];

function renderTable(props: Partial<CrossTabTableProps<Row, string>> = {}) {
  return render(
    <CrossTabTable<Row, string>
      cornerLabel="Ingredient"
      columns={columns}
      rows={rows}
      renderColumnHeader={(column) => column.data}
      renderRowHeader={(row) => row.data.name}
      renderCell={(row, column) => row.data.values[column.key] ?? null}
      {...props}
    />,
  );
}

describe("CrossTabTable", () => {
  it("renders each row as a row header scoped to its row", () => {
    renderTable();

    expect(screen.getByRole("rowheader", { name: "flour" })).toHaveAttribute(
      "scope",
      "row",
    );
    expect(screen.getByRole("rowheader", { name: "salt" })).toBeInTheDocument();
  });

  it("renders the empty mark where a row has no value, never a zero", () => {
    renderTable();

    const saltRow = screen.getByRole("rowheader", { name: "salt" })
      .parentElement as HTMLElement;
    const cells = within(saltRow).getAllByRole("cell");

    // salt only has c2 — the other two columns must read as absent.
    expect(cells.map((c) => c.textContent)).toEqual([
      EMPTY_MARK,
      "5",
      EMPTY_MARK,
    ]);
  });

  it("spans a group header across exactly its own columns", () => {
    renderTable({
      renderGroupHeader: (groupKey) => groupKey,
    });

    const g1 = screen.getByRole("columnheader", { name: "g1" });
    const g2 = screen.getByRole("columnheader", { name: "g2" });

    expect(g1).toHaveAttribute("colspan", "2");
    expect(g2).toHaveAttribute("colspan", "1");
  });

  it("omits the group header row entirely when no renderer is given", () => {
    renderTable();

    expect(screen.queryByRole("columnheader", { name: "g1" })).toBeNull();
  });

  it("pins trailing columns with their sticky offsets", () => {
    renderTable({
      pinned: [
        { key: "need", label: "Need", stickyRight: "right-20" },
        { key: "short", label: "Short", stickyRight: "right-0" },
      ],
      renderPinnedCell: (_row, pinned) =>
        pinned.key === "need" ? "10 g" : "2 g",
      tableWidth: 640,
    });

    const need = screen.getByRole("columnheader", { name: "Need" });
    const short = screen.getByRole("columnheader", { name: "Short" });

    expect(need.className).toContain("right-20");
    expect(short.className).toContain("right-0");
    expect(need.className).toContain("sticky");
  });

  it("renders footer rows over both body and pinned columns", () => {
    renderTable({
      pinned: [{ key: "total", label: "Total" }],
      renderPinnedCell: () => "150",
      footer: [
        {
          key: "count",
          label: "2 ingredients",
          cell: (columnKey) => (columnKey === "c1" ? "1" : "0"),
          pinnedCell: () => "2",
        },
      ],
    });

    const footLabel = screen.getByRole("rowheader", { name: "2 ingredients" });
    const footRow = footLabel.parentElement as HTMLElement;

    expect(
      within(footRow)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual(["1", "0", "0", "2"]);
  });

  it("drops cell padding under bareCells so a child can fill the hit area", () => {
    renderTable({
      bareCells: true,
      renderCell: () => <button type="button">cell</button>,
    });

    const cell = screen.getAllByRole("cell")[0] as HTMLElement;
    expect(cell.className).toBe("p-0");
  });
});
