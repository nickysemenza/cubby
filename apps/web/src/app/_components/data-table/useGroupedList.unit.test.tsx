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
      { kind: "header", title: "A", count: 1, color: "color:A" },
      { kind: "row", item: data[1] },
      { kind: "header", title: "B", count: 1, color: "color:B" },
      { kind: "row", item: data[0] },
    ]);
  });
});
