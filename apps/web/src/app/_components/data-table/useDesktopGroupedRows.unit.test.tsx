import type { Row } from "@tanstack/react-table";
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useDesktopGroupedRows } from "./useDesktopGroupedRows";

interface Item {
  group: string;
}

const row = (group: string, index: number) =>
  ({ original: { group }, index }) as Row<Item>;

const groupConfig = {
  field: "group",
  keyFn: (item: Item) => item.group,
  colorFn: (key: string) => `color:${key}`,
};

describe("useDesktopGroupedRows", () => {
  it("coalesces non-contiguous placeholder rows into one section", () => {
    const rows = [row("A", 0), row("B", 1), row("A", 2)];
    const { result } = renderHook(() =>
      useDesktopGroupedRows(rows, groupConfig, true),
    );

    expect(result.current).toEqual([
      { kind: "header", title: "A", count: 2, color: "color:A" },
      { kind: "row", rowIndex: 0, groupRowIndex: 0 },
      { kind: "row", rowIndex: 2, groupRowIndex: 1 },
      { kind: "header", title: "B", count: 1, color: "color:B" },
      { kind: "row", rowIndex: 1, groupRowIndex: 0 },
    ]);
  });
});
