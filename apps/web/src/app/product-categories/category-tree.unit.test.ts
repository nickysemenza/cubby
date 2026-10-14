import { describe, expect, it } from "vitest";

import { buildCategoryHierarchy, nestByParent } from "./category-tree";

const cat = (
  id: string,
  parentId: string | null,
  feature: "tools" | "food" | null = null,
) => ({ id, parentId, name: id, feature });

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

type Row = { id: string; parentId: string | null };
type Outline = string | Record<string, Outline[]>;

const row = (id: string, parentId: string | null): Row => ({ id, parentId });
const outline = (rows: ReturnType<typeof nestByParent<Row>>): Outline[] =>
  rows.map((node) =>
    node.subRows ? { [node.id]: outline(node.subRows) } : node.id,
  );

describe("nestByParent", () => {
  it.each([
    {
      name: "nests children and keeps sibling order",
      rows: [row("a", null), row("c1", "b"), row("b", "a"), row("c2", "b")],
      expected: [{ a: [{ b: ["c1", "c2"] }] }],
    },
    {
      // A search match or an unloaded page must never hide a row.
      name: "promotes a row whose parent is missing to a root",
      rows: [row("c1", "b"), row("a", null)],
      expected: ["c1", "a"],
    },
    {
      name: "treats a self-parent as a root instead of dropping it",
      rows: [row("a", "a")],
      expected: ["a"],
    },
  ])("$name", ({ rows, expected }) => {
    expect(outline(nestByParent(rows, (r) => r.parentId))).toEqual(expected);
  });
});
