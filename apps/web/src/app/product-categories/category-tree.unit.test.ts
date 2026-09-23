import { describe, expect, it } from "vitest";

import { buildCategoryHierarchy, nestProductCategories } from "./category-tree";

const cat = (
  id: string,
  parentId: string | null,
  feature: "tools" | "food" | null = null,
) => ({ id, parentId, name: id, feature });

type Outline = string | Record<string, Outline[]>;

const outline = (rows: ReturnType<typeof nestProductCategories>): Outline[] =>
  rows.map((row) =>
    row.subRows ? { [row.id]: outline(row.subRows) } : row.id,
  );

describe("nestProductCategories", () => {
  it.each([
    {
      name: "nests children and keeps sibling order",
      rows: [
        cat("tools", null),
        cat("screws", "hw"),
        cat("hw", "tools"),
        cat("nails", "hw"),
      ],
      expected: [{ tools: [{ hw: ["screws", "nails"] }] }],
    },
    {
      // A search match or an unloaded page must never hide a row.
      name: "promotes a row whose parent is missing to a root",
      rows: [cat("screws", "hw"), cat("food", null)],
      expected: ["screws", "food"],
    },
  ])("$name", ({ rows, expected }) => {
    expect(outline(nestProductCategories(rows))).toEqual(expected);
  });
});

describe("buildCategoryHierarchy", () => {
  it("rolls direct counts up and inherits the closest feature", () => {
    const root = buildCategoryHierarchy(
      [cat("tools", null, "tools"), cat("hw", "tools"), cat("screws", "hw")],
      new Map([
        ["hw", 2],
        ["screws", 5],
      ]),
    );
    const tools = root.children?.[0];
    const hw = tools?.children?.[0];
    expect(root.totalCount).toBe(7);
    expect(tools).toMatchObject({ directCount: 0, totalCount: 7 });
    expect(hw).toMatchObject({
      directCount: 2,
      totalCount: 7,
      feature: "tools",
    });
    expect(hw?.children?.[0]).toMatchObject({
      totalCount: 5,
      feature: "tools",
    });
  });
});
