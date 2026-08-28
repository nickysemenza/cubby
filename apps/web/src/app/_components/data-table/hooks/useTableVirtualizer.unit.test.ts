import { describe, expect, it } from "vitest";

import {
  flatRowToVirtualIndex,
  type GroupedItem,
  resolveVirtualIndex,
  tableVirtualItemKey,
} from "./useTableVirtualizer";

const grouped: GroupedItem[] = [
  { kind: "header", title: "A", count: 2, color: "var(--chart-1)" },
  { kind: "row", rowIndex: 0, groupRowIndex: 0 },
  { kind: "row", rowIndex: 1, groupRowIndex: 1 },
  { kind: "header", title: "B", count: 1, color: "var(--chart-2)" },
  { kind: "row", rowIndex: 2, groupRowIndex: 0 },
];

describe("resolveVirtualIndex", () => {
  it("maps virtual index directly to a flat row index when ungrouped", () => {
    expect(resolveVirtualIndex(0, null)).toEqual({ kind: "row", rowIndex: 0 });
    expect(resolveVirtualIndex(5, null)).toEqual({ kind: "row", rowIndex: 5 });
  });

  it("returns the header item at header positions when grouped", () => {
    expect(resolveVirtualIndex(0, grouped)).toEqual({
      kind: "header",
      title: "A",
      count: 2,
      color: "var(--chart-1)",
    });
    expect(resolveVirtualIndex(3, grouped)).toEqual({
      kind: "header",
      title: "B",
      count: 1,
      color: "var(--chart-2)",
    });
  });

  it("resolves grouped row positions to their flat row index (offset by headers)", () => {
    expect(resolveVirtualIndex(1, grouped)).toEqual({
      kind: "row",
      rowIndex: 0,
      groupRowIndex: 0,
    });
    expect(resolveVirtualIndex(2, grouped)).toEqual({
      kind: "row",
      rowIndex: 1,
      groupRowIndex: 1,
    });
    expect(resolveVirtualIndex(4, grouped)).toEqual({
      kind: "row",
      rowIndex: 2,
      groupRowIndex: 0,
    });
  });

  it("maps the trailing index to the infinite-scroll sentinel", () => {
    expect(resolveVirtualIndex(3, null, true, 3)).toEqual({
      kind: "sentinel",
    });
    expect(resolveVirtualIndex(5, grouped, true, 3)).toEqual({
      kind: "sentinel",
    });
  });
});

describe("tableVirtualItemKey", () => {
  const rowKeys = ["EXP-A", "EXP-B", "EXP-C"];

  it("uses entity ids rather than virtual indexes for flat rows", () => {
    expect(tableVirtualItemKey(1, rowKeys, null)).toBe("row:EXP-B");
  });

  it("keeps grouped headers, rows, and the sentinel in separate key spaces", () => {
    expect(tableVirtualItemKey(0, rowKeys, grouped, true)).toBe("group:A");
    expect(tableVirtualItemKey(2, rowKeys, grouped, true)).toBe("row:EXP-B");
    expect(tableVirtualItemKey(grouped.length, rowKeys, grouped, true)).toBe(
      "sentinel:infinite",
    );
  });
});

describe("flatRowToVirtualIndex", () => {
  it("is the identity mapping when ungrouped", () => {
    expect(flatRowToVirtualIndex(0, null)).toBe(0);
    expect(flatRowToVirtualIndex(7, null)).toBe(7);
  });

  it("skips past section headers when grouped", () => {
    expect(flatRowToVirtualIndex(0, grouped)).toBe(1);
    expect(flatRowToVirtualIndex(1, grouped)).toBe(2);
    expect(flatRowToVirtualIndex(2, grouped)).toBe(4);
  });

  it("returns -1 for a flat row index that isn't present", () => {
    expect(flatRowToVirtualIndex(99, grouped)).toBe(-1);
  });

  it("round-trips: a flat row maps to a virtual index that resolves back", () => {
    for (const rowIndex of [0, 1, 2]) {
      const virtualIndex = flatRowToVirtualIndex(rowIndex, grouped);
      expect(resolveVirtualIndex(virtualIndex, grouped)).toMatchObject({
        kind: "row",
        rowIndex,
      });
    }
  });
});
