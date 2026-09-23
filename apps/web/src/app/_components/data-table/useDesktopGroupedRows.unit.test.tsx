import { renderHook } from "@testing-library/react";
import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it } from "vitest";

import type { CubbyRow as Row } from "./table-features";
import { useDesktopGroupedRows } from "./useDesktopGroupedRows";

interface Item {
  group: string;
}

const row = (group: string, index: number) =>
  fromPartial<Row<Item>>({ original: { group }, index });

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
      {
        kind: "header",
        key: undefined,
        title: "A",
        count: 2,
        color: "color:A",
      },
      { kind: "row", rowIndex: 0, groupRowIndex: 0 },
      { kind: "row", rowIndex: 2, groupRowIndex: 1 },
      {
        kind: "header",
        key: undefined,
        title: "B",
        count: 1,
        color: "color:B",
      },
      { kind: "row", rowIndex: 1, groupRowIndex: 0 },
    ]);
  });

  it("uses full filtered counts and group order across unloaded pages", () => {
    const rows = [row("B", 0)];
    const config = {
      ...groupConfig,
      groups: [
        { key: "A", label: "First section", count: 7 },
        { key: "B", label: "Second section", count: 11 },
      ],
    };
    const { result } = renderHook(() =>
      useDesktopGroupedRows(rows, config, true),
    );
    expect(result.current).toEqual([
      {
        kind: "header",
        key: "A",
        title: "First section",
        count: 7,
        color: "color:A",
      },
      {
        kind: "header",
        key: "B",
        title: "Second section",
        count: 11,
        color: "color:B",
      },
      { kind: "row", rowIndex: 0, groupRowIndex: 0 },
    ]);
  });
});
