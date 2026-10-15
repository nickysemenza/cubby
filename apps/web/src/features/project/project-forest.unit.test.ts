import { describe, expect, it } from "vitest";

import { buildForest, type ForestNode, foldForest } from "./project-forest";

/** The two fields a forest walk reads — nothing else is needed here. */
const node = (
  id: string,
  parentProjectId: string | null = null,
): ForestNode => ({
  id,
  parentProjectId,
});

/** Pre-order id list, so a fold's shape is asserted as a flat sequence. */
const preorder = (
  forest: ReturnType<typeof buildForest<ForestNode>>,
  roots?: ForestNode[],
) =>
  foldForest<ForestNode, string[]>(
    forest,
    (n, childIds) => [n.id, ...childIds.flat()],
    roots ? { roots } : undefined,
  ).flat();

describe("buildForest", () => {
  it("returns empty everything for an empty list", () => {
    const forest = buildForest([]);
    expect(forest.roots).toEqual([]);
    expect(forest.cyclicRoots).toEqual([]);
    expect(forest.childrenByParent.size).toBe(0);
  });

  it("treats every parentless node as a root, in input order", () => {
    const forest = buildForest([node("a"), node("b"), node("c")]);
    expect(forest.roots.map((n) => n.id)).toEqual(["a", "b", "c"]);
  });

  it("groups children under their parent, preserving input order", () => {
    // Input order is B then A — the map must follow input, not alpha sort.
    const forest = buildForest([
      node("parent"),
      node("childB", "parent"),
      node("childA", "parent"),
    ]);
    expect(forest.roots.map((n) => n.id)).toEqual(["parent"]);
    expect(forest.childrenByParent.get("parent")?.map((n) => n.id)).toEqual([
      "childB",
      "childA",
    ]);
  });

  it("promotes an orphan — a node whose parent isn't in the input — to a root", () => {
    const forest = buildForest([node("child", "missing-parent")]);
    expect(forest.roots.map((n) => n.id)).toEqual(["child"]);
    expect(forest.cyclicRoots).toEqual([]);
  });

  it("reports nodes in a parent cycle as cyclicRoots, not roots", () => {
    const forest = buildForest([node("a", "b"), node("b", "a")]);
    expect(forest.roots).toEqual([]);
    expect(forest.cyclicRoots.map((n) => n.id)).toEqual(["a", "b"]);
  });

  it("does not mistake a deep acyclic chain for a cycle", () => {
    const ids = Array.from({ length: 150 }, (_, i) => `n${i}`);
    const forest = buildForest(
      ids.map((id, i) => (i === 0 ? node(id) : node(id, ids[i - 1] ?? null))),
    );
    expect(forest.roots.map((n) => n.id)).toEqual(["n0"]);
    expect(forest.cyclicRoots).toEqual([]);
  });
});

describe("foldForest", () => {
  it("folds a chain post-order, passing child results up", () => {
    const forest = buildForest([node("a"), node("b", "a"), node("c", "b")]);
    const depths = foldForest<ForestNode, Record<string, number>>(
      forest,
      (n, childDepths, depth) =>
        Object.assign({ [n.id]: depth }, ...childDepths),
    );
    expect(depths).toEqual([{ a: 0, b: 1, c: 2 }]);
  });

  it("emits each node exactly once even when every node is passed as a root", () => {
    const forest = buildForest([node("a"), node("b", "a"), node("c", "b")]);
    expect(preorder(forest, [...forest.roots, ...forest.cyclicRoots])).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("folds each node once even when a root is listed before its own parent", () => {
    const items = [node("c", "b"), node("b", "a"), node("a")];
    const forest = buildForest(items);
    const folded: string[] = [];
    const depths = foldForest<ForestNode, number>(
      forest,
      (n, _children, depth) => {
        folded.push(n.id);
        return depth;
      },
      { roots: items },
    );

    expect(folded).toEqual(["c", "b", "a"]);
    expect(depths).toEqual([0, 0, 0]);
  });

  it("gives a parent its child's result even when the child was folded first", () => {
    // The memo must RETURN the cached fold, not skip the child: a parent that
    // aggregates over its descendants (the Gantt's extent pass) would
    // otherwise silently lose them.
    const items = [node("child", "parent"), node("parent")];
    const forest = buildForest(items);
    const subtreeIds = foldForest<ForestNode, string[]>(
      forest,
      (n, childIds) => [n.id, ...childIds.flat()],
      { roots: items },
    );

    expect(subtreeIds).toEqual([["child"], ["parent", "child"]]);
  });

  it("skips a node's children when `descend` says no", () => {
    const forest = buildForest([
      node("a"),
      node("b", "a"),
      node("c", "b"),
      node("d"),
    ]);
    const rows = foldForest<ForestNode, string[]>(
      forest,
      (n, childIds) => [n.id, ...childIds.flat()],
      { descend: (n) => n.id === "a" },
    ).flat();
    // "a" expands to "b"; "b" is collapsed so "c" never appears.
    expect(rows).toEqual(["a", "b", "d"]);
  });

  it("drops the cycle-closing edge, emitting each node once", () => {
    const forest = buildForest([node("a", "b"), node("b", "a")]);
    const ids = preorder(forest, forest.cyclicRoots);
    expect(ids).toEqual(["a", "b"]);
  });

  it("emits nothing when a cyclic forest is walked from `roots` alone", () => {
    const forest = buildForest([node("a", "b"), node("b", "a")]);
    expect(preorder(forest)).toEqual([]);
  });

  it("truncates a chain past the depth cap instead of throwing or promoting", () => {
    const ids = Array.from({ length: 150 }, (_, i) => `n${i}`);
    const forest = buildForest(
      ids.map((id, i) => (i === 0 ? node(id) : node(id, ids[i - 1] ?? null))),
    );
    const walked = preorder(forest);
    expect(walked[0]).toBe("n0");
    expect(walked.length).toBe(101);
    expect(new Set(walked).size).toBe(walked.length);
  });
});
