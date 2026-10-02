import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useGroupedList } from "./useGroupedList";

interface Item {
  id: string;
  group: string;
}

const groupConfig = {
  field: "group",
  keyFn: (item: Item) => item.group,
  colorFn: (key: string) => `color:${key}`,
};

describe("useGroupedList", () => {
  it("keeps each item paired with its header when sorting groups", () => {
    const data: Item[] = [
      { id: "b", group: "B" },
      { id: "a", group: "A" },
    ];
    const { result } = renderHook(() =>
      useGroupedList(data, groupConfig, true),
    );

    expect(result.current).toEqual([
      {
        kind: "header",
        key: undefined,
        title: "A",
        count: 1,
        color: "color:A",
      },
      { kind: "row", item: data[1] },
      {
        kind: "header",
        key: undefined,
        title: "B",
        count: 1,
        color: "color:B",
      },
      { kind: "row", item: data[0] },
    ]);
  });

  it("uses server headings and full counts before all rows are loaded", () => {
    const data: Item[] = [
      { id: "b", group: "B" },
      { id: "c", group: "C" },
    ];
    const config = {
      ...groupConfig,
      groups: [
        { key: "A", label: "First section", count: 4 },
        { key: "B", label: "Second section", count: 9 },
      ],
    };
    const { result } = renderHook(() => useGroupedList(data, config, true));
    expect(result.current).toEqual([
      {
        kind: "header",
        key: "A",
        title: "First section",
        count: 4,
        color: "color:A",
      },
      {
        kind: "header",
        key: "B",
        title: "Second section",
        count: 9,
        color: "color:B",
      },
      { kind: "row", item: data[0] },
      {
        kind: "header",
        key: undefined,
        title: "C",
        count: 1,
        color: "color:C",
      },
      { kind: "row", item: data[1] },
    ]);
  });
});
