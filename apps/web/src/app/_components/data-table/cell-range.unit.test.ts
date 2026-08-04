import { describe, expect, it } from "vitest";
import {
  buildPastePlan,
  type CellSelection,
  type CopiedGrid,
  clampSelection,
  gridToTsv,
  moveFocus,
  type PasteColumnTarget,
  parseTsv,
  selectionRect,
} from "./cell-range";

describe("selectionRect", () => {
  it("normalizes a forward selection", () => {
    const sel: CellSelection = {
      anchor: { row: 1, col: 1 },
      focus: { row: 3, col: 4 },
    };
    expect(selectionRect(sel)).toEqual({
      top: 1,
      left: 1,
      bottom: 3,
      right: 4,
    });
  });

  it("normalizes an inverted selection (focus before anchor)", () => {
    const sel: CellSelection = {
      anchor: { row: 3, col: 4 },
      focus: { row: 1, col: 1 },
    };
    expect(selectionRect(sel)).toEqual({
      top: 1,
      left: 1,
      bottom: 3,
      right: 4,
    });
  });

  it("normalizes a mixed-axis inverted selection", () => {
    const sel: CellSelection = {
      anchor: { row: 0, col: 5 },
      focus: { row: 5, col: 0 },
    };
    expect(selectionRect(sel)).toEqual({
      top: 0,
      left: 0,
      bottom: 5,
      right: 5,
    });
  });

  it("handles a single-cell selection", () => {
    const sel: CellSelection = {
      anchor: { row: 2, col: 2 },
      focus: { row: 2, col: 2 },
    };
    expect(selectionRect(sel)).toEqual({
      top: 2,
      left: 2,
      bottom: 2,
      right: 2,
    });
  });
});

describe("moveFocus", () => {
  it("returns a selection at {0,0} when starting from null", () => {
    expect(moveFocus(null, "right", false, 5, 5)).toEqual({
      anchor: { row: 0, col: 0 },
      focus: { row: 0, col: 0 },
    });
  });

  it("returns null from null when the table is empty", () => {
    expect(moveFocus(null, "right", false, 0, 5)).toBeNull();
    expect(moveFocus(null, "right", false, 5, 0)).toBeNull();
  });

  it("moves both anchor and focus (collapsing a range) when extend is false", () => {
    const sel: CellSelection = {
      anchor: { row: 1, col: 1 },
      focus: { row: 3, col: 3 },
    };
    expect(moveFocus(sel, "down", false, 10, 10)).toEqual({
      anchor: { row: 4, col: 3 },
      focus: { row: 4, col: 3 },
    });
  });

  it("moves only focus, pinning anchor, when extend is true", () => {
    const sel: CellSelection = {
      anchor: { row: 1, col: 1 },
      focus: { row: 1, col: 1 },
    };
    expect(moveFocus(sel, "right", true, 10, 10)).toEqual({
      anchor: { row: 1, col: 1 },
      focus: { row: 1, col: 2 },
    });
  });

  it("clamps at the top edge", () => {
    const sel: CellSelection = {
      anchor: { row: 0, col: 0 },
      focus: { row: 0, col: 0 },
    };
    expect(moveFocus(sel, "up", false, 5, 5)).toEqual({
      anchor: { row: 0, col: 0 },
      focus: { row: 0, col: 0 },
    });
  });

  it("clamps at the bottom edge", () => {
    const sel: CellSelection = {
      anchor: { row: 4, col: 0 },
      focus: { row: 4, col: 0 },
    };
    expect(moveFocus(sel, "down", false, 5, 5)).toEqual({
      anchor: { row: 4, col: 0 },
      focus: { row: 4, col: 0 },
    });
  });

  it("clamps at the left edge", () => {
    const sel: CellSelection = {
      anchor: { row: 0, col: 0 },
      focus: { row: 0, col: 0 },
    };
    expect(moveFocus(sel, "left", false, 5, 5)).toEqual({
      anchor: { row: 0, col: 0 },
      focus: { row: 0, col: 0 },
    });
  });

  it("clamps at the right edge", () => {
    const sel: CellSelection = {
      anchor: { row: 0, col: 4 },
      focus: { row: 0, col: 4 },
    };
    expect(moveFocus(sel, "right", false, 5, 5)).toEqual({
      anchor: { row: 0, col: 4 },
      focus: { row: 0, col: 4 },
    });
  });

  it("clamps extend-mode focus at an edge without moving anchor", () => {
    const sel: CellSelection = {
      anchor: { row: 2, col: 2 },
      focus: { row: 0, col: 2 },
    };
    expect(moveFocus(sel, "up", true, 5, 5)).toEqual({
      anchor: { row: 2, col: 2 },
      focus: { row: 0, col: 2 },
    });
  });
});

describe("clampSelection", () => {
  it("shrinks a selection that extends beyond new bounds", () => {
    const sel: CellSelection = {
      anchor: { row: 0, col: 0 },
      focus: { row: 9, col: 9 },
    };
    expect(clampSelection(sel, 3, 4)).toEqual({
      anchor: { row: 0, col: 0 },
      focus: { row: 2, col: 3 },
    });
  });

  it("returns null when rowCount is zero", () => {
    const sel: CellSelection = {
      anchor: { row: 0, col: 0 },
      focus: { row: 0, col: 0 },
    };
    expect(clampSelection(sel, 0, 4)).toBeNull();
  });

  it("returns null when colCount is zero", () => {
    const sel: CellSelection = {
      anchor: { row: 0, col: 0 },
      focus: { row: 0, col: 0 },
    };
    expect(clampSelection(sel, 4, 0)).toBeNull();
  });
});

describe("gridToTsv / parseTsv round trip", () => {
  it("round-trips a simple rectangular grid", () => {
    const grid: CopiedGrid = [
      [
        { kind: "text", text: "a", json: "a" },
        { kind: "text", text: "b", json: "b" },
      ],
      [
        { kind: "text", text: "c", json: "c" },
        { kind: "text", text: "d", json: "d" },
      ],
    ];
    const tsv = gridToTsv(grid);
    expect(tsv).toBe("a\tb\nc\td");
    expect(parseTsv(tsv)).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("preserves empty cells", () => {
    const grid: CopiedGrid = [
      [
        { kind: "text", text: "", json: null },
        { kind: "text", text: "x", json: "x" },
      ],
    ];
    expect(gridToTsv(grid)).toBe("\tx");
    expect(parseTsv("\tx")).toEqual([["", "x"]]);
  });

  it("sanitizes embedded tabs and newlines in cell text to a single space", () => {
    const grid: CopiedGrid = [
      [{ kind: "text", text: "a\tb\nc\r\nd", json: "raw" }],
    ];
    expect(gridToTsv(grid)).toBe("a b c d");
  });

  it("parses \\r\\n line endings", () => {
    expect(parseTsv("a\tb\r\nc\td")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("pads ragged rows to the max width", () => {
    expect(parseTsv("a\tb\tc\nd")).toEqual([
      ["a", "b", "c"],
      ["d", "", ""],
    ]);
  });

  it("drops a single trailing empty line from a trailing newline", () => {
    expect(parseTsv("a\tb\n")).toEqual([["a", "b"]]);
  });

  it("does not drop a genuine trailing blank row (only one empty line dropped)", () => {
    expect(parseTsv("a\tb\n\n")).toEqual([
      ["a", "b"],
      ["", ""],
    ]);
  });

  it("parses a single cell with no delimiters", () => {
    expect(parseTsv("solo")).toEqual([["solo"]]);
  });
});

describe("buildPastePlan", () => {
  const cell = (
    text: string,
    kind: CopiedGrid[number][number]["kind"] = "text",
  ) => ({
    kind,
    text,
    json: text,
  });

  const textCol: PasteColumnTarget = { kind: "text", canPaste: true };
  const numberCol: PasteColumnTarget = { kind: "number", canPaste: true };
  const lockedCol: PasteColumnTarget = { kind: "text", canPaste: false };

  it("fill mode: fills every cell in the selection from the single source cell", () => {
    const grid: CopiedGrid = [[cell("x")]];
    const plan = buildPastePlan({
      grid,
      selection: { top: 0, left: 0, bottom: 1, right: 1 },
      columns: [textCol, textCol],
      rowCount: 5,
    });

    expect(plan.cellTotal).toBe(4);
    expect(plan.ops).toHaveLength(4);
    for (const op of plan.ops) {
      expect(op.source.text).toBe("x");
    }
    const coords = plan.ops.map((o) => `${o.row},${o.col}`).sort();
    expect(coords).toEqual(["0,0", "0,1", "1,0", "1,1"]);
  });

  it("anchor mode: extends target region by the grid's own dimensions from the top-left", () => {
    const grid: CopiedGrid = [
      [cell("a"), cell("b")],
      [cell("c"), cell("d")],
    ];
    const plan = buildPastePlan({
      grid,
      selection: { top: 2, left: 0, bottom: 2, right: 0 }, // 1x1 anchor selection
      columns: [textCol, textCol],
      rowCount: 10,
    });

    expect(plan.cellTotal).toBe(4);
    const byCoord = new Map(
      plan.ops.map((o) => [`${o.row},${o.col}`, o.source.text]),
    );
    expect(byCoord.get("2,0")).toBe("a");
    expect(byCoord.get("2,1")).toBe("b");
    expect(byCoord.get("3,0")).toBe("c");
    expect(byCoord.get("3,1")).toBe("d");
  });

  it("anchor mode: clamps at the right edge, dropping out-of-bounds columns", () => {
    const grid: CopiedGrid = [[cell("a"), cell("b"), cell("c")]];
    const plan = buildPastePlan({
      grid,
      selection: { top: 0, left: 0, bottom: 0, right: 0 },
      columns: [textCol, textCol], // only 2 columns exist
      rowCount: 5,
    });

    // target region clamped to cols [0,1]; the 3rd source column is dropped
    expect(plan.cellTotal).toBe(2);
    expect(plan.ops).toHaveLength(2);
    const cols = plan.ops.map((o) => o.col).sort();
    expect(cols).toEqual([0, 1]);
  });

  it("anchor mode: clamps at the bottom edge, dropping out-of-bounds rows", () => {
    const grid: CopiedGrid = [[cell("a")], [cell("b")], [cell("c")]];
    const plan = buildPastePlan({
      grid,
      selection: { top: 3, left: 0, bottom: 3, right: 0 },
      columns: [textCol],
      rowCount: 5, // rows 0..4; starting at row 3 only rows 3,4 fit
    });

    expect(plan.cellTotal).toBe(2);
    expect(plan.ops).toHaveLength(2);
    const rows = plan.ops.map((o) => o.row).sort();
    expect(rows).toEqual([3, 4]);
  });

  it("skips a whole column on kind mismatch, still counting its cells in cellTotal", () => {
    const grid: CopiedGrid = [[cell("a", "text"), cell("1", "number")]];
    const plan = buildPastePlan({
      grid,
      selection: { top: 0, left: 0, bottom: 0, right: 0 },
      columns: [textCol, textCol], // second target column is "text", source is "number" -> mismatch
      rowCount: 5,
    });

    expect(plan.cellTotal).toBe(2);
    expect(plan.ops).toHaveLength(1);
    expect(plan.ops[0]?.col).toBe(0);
  });

  it("skips a whole column when canPaste is false", () => {
    const grid: CopiedGrid = [
      [cell("a"), cell("b")],
      [cell("c"), cell("d")],
    ];
    const plan = buildPastePlan({
      grid,
      selection: { top: 0, left: 0, bottom: 1, right: 1 },
      columns: [textCol, lockedCol],
      rowCount: 5,
    });

    expect(plan.cellTotal).toBe(4);
    expect(plan.ops).toHaveLength(2);
    for (const op of plan.ops) {
      expect(op.col).toBe(0);
    }
  });

  it("skips a column missing from the columns array (out-of-range index)", () => {
    const grid: CopiedGrid = [[cell("a"), cell("b")]];
    const plan = buildPastePlan({
      grid,
      selection: { top: 0, left: 0, bottom: 0, right: 0 },
      columns: [textCol], // only index 0 exists; anchor mode wants col 1 too
      rowCount: 5,
    });

    expect(plan.cellTotal).toBe(1); // target region clamped to columns.length - 1 = 0
    expect(plan.ops).toHaveLength(1);
  });

  it("emits ops only for the matching column when others are skipped", () => {
    const grid: CopiedGrid = [[cell("1", "number"), cell("2", "number")]];
    const plan = buildPastePlan({
      grid,
      selection: { top: 0, left: 0, bottom: 0, right: 0 },
      columns: [textCol, numberCol], // col0 mismatches (text vs number), col1 matches
      rowCount: 5,
    });

    expect(plan.ops).toHaveLength(1);
    expect(plan.ops[0]?.col).toBe(1);
  });
});
