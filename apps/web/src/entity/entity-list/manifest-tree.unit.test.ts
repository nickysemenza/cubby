import { describe, expect, it } from "vitest";

import { nestByParent, type TreeRow } from "./manifest-tree";

type Row = { id: string; parentId: string | null };
type Outline = string | Record<string, Outline[]>;

const row = (id: string, parentId: string | null): Row => ({ id, parentId });
const outline = (rows: TreeRow<Row>[]): Outline[] =>
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
