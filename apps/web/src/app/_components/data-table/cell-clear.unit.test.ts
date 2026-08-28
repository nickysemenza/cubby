import { describe, expect, it, vi } from "vitest";

import { resolveCellClearTarget } from "./cell-clear";
import type { CellJsonValue } from "./cell-clipboard";
import type { CellSelection } from "./cell-clipboard-model";
import type { ColumnCellData } from "./cell-data";

interface Row {
  id: string;
  relation: string | null;
}

const rows: Row[] = [
  { id: "one", relation: "PRJ-2ABC" },
  { id: "empty", relation: null },
];
const single: CellSelection = {
  anchor: { row: 0, col: 0 },
  focus: { row: 0, col: 0 },
};

const column = (
  applyClear?: (row: Row) => Promise<CellJsonValue | null>,
): ColumnCellData<Row> => ({
  kind: "entity:project",
  getCopyPayload: (row) =>
    row.relation ? { text: row.relation, json: row.relation } : null,
  applyClear,
});

describe("resolveCellClearTarget", () => {
  it("resolves a single nonempty nullable relation and preserves its coordinate", async () => {
    const clear = vi.fn().mockResolvedValue(null);
    const target = resolveCellClearTarget({
      selection: single,
      rows,
      columnCellData: [column(clear)],
    });
    expect(target?.coord).toEqual(single.focus);
    await expect(target?.apply()).resolves.toBeNull();
    expect(clear).toHaveBeenCalledWith(rows[0]);
  });

  it("does nothing for a required relation without the capability", () => {
    expect(
      resolveCellClearTarget({
        selection: single,
        rows,
        columnCellData: [column()],
      }),
    ).toBeNull();
  });

  it("does nothing for an empty cell", () => {
    const emptySelection: CellSelection = {
      anchor: { row: 1, col: 0 },
      focus: { row: 1, col: 0 },
    };
    expect(
      resolveCellClearTarget({
        selection: emptySelection,
        rows,
        columnCellData: [column(vi.fn())],
      }),
    ).toBeNull();
  });

  it("does nothing for a multi-cell range", () => {
    expect(
      resolveCellClearTarget({
        selection: {
          anchor: { row: 0, col: 0 },
          focus: { row: 1, col: 0 },
        },
        rows,
        columnCellData: [column(vi.fn())],
      }),
    ).toBeNull();
  });

  it("propagates a failed mutation so the keyboard host can report it", async () => {
    const target = resolveCellClearTarget({
      selection: single,
      rows,
      columnCellData: [
        column(vi.fn().mockRejectedValue(new Error("could not clear"))),
      ],
    });
    await expect(target?.apply()).rejects.toThrow("could not clear");
  });
});
