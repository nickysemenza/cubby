import { describe, expect, it, vi } from "vitest";
import type { ColumnCellData } from "./cell-data";
import {
  alignExternalGrid,
  buildCopyGrid,
  isOpUnchanged,
  runPastePlan,
  summarizePasteResult,
} from "./cell-paste-executor";
import type { CellRect, CopiedCell, PasteOp } from "./cell-range";

interface Row {
  id: string;
  name: string | null;
  qty: number | null;
}

/** Text column cellData whose copy payload is the row's `name`. */
function nameCol(
  save?: (row: Row, v: string | null) => Promise<void>,
): ColumnCellData<Row> {
  return {
    kind: "text",
    getCopyPayload: (row) =>
      row.name == null || row.name === ""
        ? null
        : { text: row.name, json: row.name },
    applyPaste: save
      ? async (row, { json, text }) => {
          const raw = typeof json === "string" ? json : (text ?? "");
          const next = raw.trim() === "" ? null : raw.trim();
          await save(row, next);
          return next;
        }
      : undefined,
  };
}

/** Number column cellData over `qty`. */
function qtyCol(
  save?: (row: Row, v: number | null) => Promise<void>,
): ColumnCellData<Row> {
  return {
    kind: "number",
    getCopyPayload: (row) =>
      row.qty == null ? null : { text: String(row.qty), json: row.qty },
    applyPaste: save
      ? async (row, { json, text }) => {
          const num =
            typeof json === "number" ? json : Number.parseFloat(text ?? "");
          if (Number.isNaN(num))
            throw new Error("Pasted value is not a number");
          await save(row, num);
          return num;
        }
      : undefined,
  };
}

const rows: Row[] = [
  { id: "a", name: "Alpha", qty: 1 },
  { id: "b", name: "Bravo", qty: 2 },
  { id: "c", name: null, qty: null },
];

describe("buildCopyGrid", () => {
  it("copies a rect with kind + typed json per cell", () => {
    const rect: CellRect = { top: 0, left: 0, bottom: 1, right: 1 };
    const grid = buildCopyGrid({
      rect,
      rows,
      columnCellData: [nameCol(), qtyCol()],
    });
    expect(grid).toEqual([
      [
        { kind: "text", text: "Alpha", json: "Alpha" },
        { kind: "number", text: "1", json: 1 },
      ],
      [
        { kind: "text", text: "Bravo", json: "Bravo" },
        { kind: "number", text: "2", json: 2 },
      ],
    ]);
  });

  it("keeps the column kind but empties text/json when the payload is null", () => {
    const rect: CellRect = { top: 2, left: 0, bottom: 2, right: 1 };
    const grid = buildCopyGrid({
      rect,
      rows,
      columnCellData: [nameCol(), qtyCol()],
    });
    expect(grid).toEqual([
      [
        { kind: "text", text: "", json: null },
        { kind: "number", text: "", json: null },
      ],
    ]);
  });

  it("emits a plain empty text cell for a column with no cellData", () => {
    const rect: CellRect = { top: 0, left: 0, bottom: 0, right: 1 };
    const grid = buildCopyGrid({
      rect,
      rows,
      columnCellData: [null, qtyCol()],
    });
    expect(grid[0]?.[0]).toEqual({ kind: "text", text: "", json: null });
    expect(grid[0]?.[1]).toEqual({ kind: "number", text: "1", json: 1 });
  });
});

describe("alignExternalGrid", () => {
  it("adopts each target column's kind for anchor-mode paste (json undefined)", () => {
    const rect: CellRect = { top: 0, left: 0, bottom: 0, right: 1 };
    const grid = alignExternalGrid({
      textGrid: [["Zed", "9"]],
      rect,
      columnKinds: ["text", "number"],
    });
    expect(grid).toEqual([
      [
        { kind: "text", text: "Zed", json: undefined },
        { kind: "number", text: "9", json: undefined },
      ],
    ]);
  });

  it("offsets alignment by rect.left", () => {
    const rect: CellRect = { top: 0, left: 1, bottom: 0, right: 1 };
    const grid = alignExternalGrid({
      textGrid: [["9"]],
      rect,
      columnKinds: ["text", "number"],
    });
    expect(grid[0]?.[0]?.kind).toBe("number");
  });

  it("falls back to text kind when the target column is out of range", () => {
    const rect: CellRect = { top: 0, left: 0, bottom: 0, right: 0 };
    const grid = alignExternalGrid({
      textGrid: [["x", "y"]],
      rect,
      columnKinds: ["select"],
    });
    expect(grid[0]?.[0]?.kind).toBe("select");
    expect(grid[0]?.[1]?.kind).toBe("text");
  });
});

describe("isOpUnchanged", () => {
  const cell = (json: unknown): CopiedCell => ({
    kind: "text",
    text: "x",
    json,
  });

  it("treats an undefined json (text path) as always changed", () => {
    expect(isOpUnchanged(cell(undefined), "x")).toBe(false);
  });

  it("skips a deep-equal typed value", () => {
    expect(
      isOpUnchanged(cell({ id: "1", name: "A" }), { id: "1", name: "A" }),
    ).toBe(true);
  });

  it("attempts a differing typed value", () => {
    expect(isOpUnchanged(cell("A"), "B")).toBe(false);
    expect(isOpUnchanged(cell(null), "B")).toBe(false);
  });
});

describe("runPastePlan", () => {
  const op = (row: number, col: number, source: CopiedCell): PasteOp => ({
    row,
    col,
    source,
  });

  it("skips unchanged writes and applies the rest", async () => {
    const saveName = vi.fn(async () => {});
    const saveQty = vi.fn(async () => {});
    const cellData = [nameCol(saveName), qtyCol(saveQty)];
    const result = await runPastePlan({
      // paste "Alpha" (== current) into row 0 name → unchanged;
      // paste "New" into row 1 name → updated.
      ops: [
        op(0, 0, { kind: "text", text: "Alpha", json: "Alpha" }),
        op(1, 0, { kind: "text", text: "New", json: "New" }),
      ],
      rows,
      columnCellData: cellData,
      formatError: (e) => (e instanceof Error ? e.message : String(e)),
    });
    expect(result.updated).toBe(1);
    expect(result.unchanged).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.updatedOps).toHaveLength(1);
    expect(saveName).toHaveBeenCalledTimes(1);
    expect(saveName).toHaveBeenCalledWith(rows[1], "New");
  });

  it("captures per-op errors without rejecting the batch", async () => {
    const cellData = [
      nameCol(),
      qtyCol(async () => {
        throw new Error("boom");
      }),
    ];
    const result = await runPastePlan({
      ops: [op(0, 1, { kind: "number", text: "5", json: 5 })],
      rows,
      columnCellData: cellData,
      formatError: (e) => (e instanceof Error ? e.message : String(e)),
    });
    expect(result.updated).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors).toEqual(["boom"]);
    expect(result.updatedOps).toHaveLength(0);
  });

  it("always attempts a text-path op (undefined json)", async () => {
    const saveName = vi.fn(async () => {});
    const result = await runPastePlan({
      // text path, value equals current "Alpha" text — still attempted.
      ops: [op(0, 0, { kind: "text", text: "Alpha", json: undefined })],
      rows,
      columnCellData: [nameCol(saveName)],
      formatError: String,
    });
    expect(result.updated).toBe(1);
    expect(saveName).toHaveBeenCalledTimes(1);
  });

  it("respects the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const slowSave = async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
    };
    const bigRows: Row[] = Array.from({ length: 20 }, (_, i) => ({
      id: String(i),
      name: `n${i}`,
      qty: i,
    }));
    const ops = bigRows.map((_, i) =>
      op(i, 0, { kind: "text", text: `v${i}`, json: `v${i}` }),
    );
    const result = await runPastePlan({
      ops,
      rows: bigRows,
      columnCellData: [nameCol(slowSave)],
      formatError: String,
      concurrency: 5,
    });
    expect(result.updated).toBe(20);
    expect(peak).toBeLessThanOrEqual(5);
  });
});

describe("summarizePasteResult", () => {
  it("reports a clean all-success paste", () => {
    expect(
      summarizePasteResult({
        cellTotal: 3,
        opCount: 3,
        updated: 3,
        unchanged: 0,
        failed: 0,
        errors: [],
      }),
    ).toEqual({ variant: "success", message: "3 cells updated" });
  });

  it("singularizes a one-cell success", () => {
    expect(
      summarizePasteResult({
        cellTotal: 1,
        opCount: 1,
        updated: 1,
        unchanged: 0,
        failed: 0,
        errors: [],
      }).message,
    ).toBe("1 cell updated");
  });

  it("counts type-skipped cells (cellTotal - opCount) in a mixed result", () => {
    const s = summarizePasteResult({
      cellTotal: 6, // 3 rows x 2 cols; one col skipped
      opCount: 3,
      updated: 3,
      unchanged: 0,
      failed: 0,
      errors: [],
    });
    expect(s.variant).toBe("warning");
    expect(s.message).toBe("3 updated · 3 skipped (type)");
  });

  it("appends the shared error message when all failures match", () => {
    const s = summarizePasteResult({
      cellTotal: 2,
      opCount: 2,
      updated: 0,
      unchanged: 0,
      failed: 2,
      errors: ["not a number", "not a number"],
    });
    expect(s.variant).toBe("error");
    expect(s.message).toBe("0 updated · 2 failed: not a number");
  });

  it("omits the error suffix when failures differ", () => {
    const s = summarizePasteResult({
      cellTotal: 2,
      opCount: 2,
      updated: 1,
      unchanged: 0,
      failed: 1,
      errors: ["bad"],
    });
    expect(s.variant).toBe("error");
    expect(s.message).toBe("1 updated · 1 failed: bad");
  });

  it("returns a neutral info toast when every column type mismatched", () => {
    expect(
      summarizePasteResult({
        cellTotal: 4,
        opCount: 0,
        updated: 0,
        unchanged: 0,
        failed: 0,
        errors: [],
      }),
    ).toEqual({
      variant: "info",
      message: "Nothing to paste here (column types don't match)",
    });
  });

  it("returns a neutral info toast when everything was already up to date", () => {
    expect(
      summarizePasteResult({
        cellTotal: 3,
        opCount: 3,
        updated: 0,
        unchanged: 3,
        failed: 0,
        errors: [],
      }),
    ).toEqual({
      variant: "info",
      message: "Nothing to paste — values already match",
    });
  });
});
