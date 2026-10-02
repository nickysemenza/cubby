import { describe, expect, it } from "vitest";

import { treePickerItems } from "./tree-items";

interface Node {
  id: string;
  parentId: string | null;
  name: string;
}

const nodes: Node[] = [
  { id: "apparel", parentId: null, name: "Apparel" },
  { id: "outerwear", parentId: "apparel", name: "Outerwear" },
  { id: "rain-shell", parentId: "outerwear", name: "Rain shell" },
  { id: "tools", parentId: null, name: "Tools" },
  { id: "hand-tools", parentId: "tools", name: "Hand tools" },
];

const baseOptions = {
  idOf: (node: Node) => node.id,
  parentIdOf: (node: Node) => node.parentId,
  labelOf: (node: Node) => node.name,
};

describe("treePickerItems", () => {
  it("emits every node depth-first, grouped and indented under its root", () => {
    const items = treePickerItems(nodes, baseOptions);

    expect(items.map((item) => item.id)).toEqual([
      "apparel",
      "outerwear",
      "rain-shell",
      "tools",
      "hand-tools",
    ]);
    expect(items.map((item) => item.presentation?.depth)).toEqual([
      0, 1, 2, 0, 1,
    ]);
    expect(items.map((item) => item.presentation?.group?.id)).toEqual([
      "apparel",
      "apparel",
      "apparel",
      "tools",
      "tools",
    ]);
  });

  it("sorts roots alphabetically by label regardless of input order", () => {
    const rootsOf = (items: ReturnType<typeof treePickerItems>) =>
      items.filter((item) => item.presentation?.depth === 0).map((i) => i.id);

    expect(rootsOf(treePickerItems(nodes, baseOptions))).toEqual([
      "apparel",
      "tools",
    ]);
    expect(rootsOf(treePickerItems([...nodes].reverse(), baseOptions))).toEqual(
      ["apparel", "tools"],
    );
  });

  it("sets detail to the ancestor path, omitted for a root", () => {
    const items = treePickerItems(nodes, baseOptions);
    const byId = Object.fromEntries(items.map((item) => [item.id, item]));

    expect(byId.apparel?.detail).toBeUndefined();
    expect(byId.outerwear?.detail).toBe("Apparel");
    expect(byId["rain-shell"]?.detail).toBe("Apparel > Outerwear");
  });

  it("treats a node whose parent is absent from the roster as its own root", () => {
    const orphan: Node = { id: "orphan", parentId: "ghost", name: "Orphan" };
    const items = treePickerItems([...nodes, orphan], baseOptions);
    const orphanItem = items.find((item) => item.id === "orphan");

    expect(orphanItem?.presentation?.depth).toBe(0);
    expect(orphanItem?.presentation?.group?.id).toBe("orphan");
  });

  it("honors an explicit rootOrder over the alphabetical default", () => {
    const items = treePickerItems(nodes, {
      ...baseOptions,
      rootOrder: (a, b) => (a.id === "tools" ? -1 : b.id === "tools" ? 1 : 0),
    });

    expect(
      items.filter((item) => item.presentation?.depth === 0).map((i) => i.id),
    ).toEqual(["tools", "apparel"]);
  });
});
