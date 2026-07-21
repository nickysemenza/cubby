import {
  unsafeInventoryId,
  unsafeLocationId,
} from "@cubby/schemas/identifiers";
import type {
  InfLocation,
  InventoryItemForTree,
} from "@cubby/schemas/location";
import { describe, expect, it } from "vitest";
import { canDropOnArrangeTarget } from "./arrange-drop-policy";
import {
  applyItemMove,
  applyLocationMove,
  childrenOf,
  findNode,
  findUnknownRoot,
  isSelfOrDescendant,
  isValidItemDrop,
  isValidLocationDrop,
  parentIdOf,
  pathToNode,
} from "./arrange-tree-utils";

// Minimal fixture factories. The pure fns only read id/name/parent/children/
// inventoryItems, so we cast a partial rather than build a full LocationOut.
function loc(
  id: string,
  name: string,
  children: InfLocation[] = [],
  items: InventoryItemForTree[] = [],
): InfLocation {
  return {
    id: unsafeLocationId(id),
    name,
    children,
    inventoryItems: items,
  } as unknown as InfLocation;
}

function item(id: string, productId: string): InventoryItemForTree {
  return {
    id: unsafeInventoryId(id),
    amount: { value: 1, unit: "count" },
    productName: `p-${productId}`,
    productId: unsafeLocationId(productId),
  } as unknown as InventoryItemForTree;
}

const L = (id: string) => unsafeLocationId(id);
const I = (id: string) => unsafeInventoryId(id);

// garage → [shelfA → [bin1], shelfB], kitchen → [pantry], Unknown
function buildTree(): InfLocation[] {
  return [
    loc("garage", "Garage", [
      loc("shelfA", "Shelf A", [loc("bin1", "Bin 1")], [item("i1", "prodX")]),
      loc("shelfB", "Shelf B"),
    ]),
    loc("kitchen", "Kitchen", [loc("pantry", "Pantry")]),
    loc("unknown", "Unknown"),
  ];
}

describe("findNode / parentIdOf", () => {
  it("finds a deeply nested node", () => {
    expect(findNode(buildTree(), L("bin1"))?.name).toBe("Bin 1");
  });
  it("returns null for a missing node", () => {
    expect(findNode(buildTree(), L("nope"))).toBeNull();
  });
  it("returns the parent id, null for a root", () => {
    const t = buildTree();
    expect(parentIdOf(t, L("bin1"))).toBe(L("shelfA"));
    expect(parentIdOf(t, L("shelfA"))).toBe(L("garage"));
    expect(parentIdOf(t, L("garage"))).toBeNull();
  });
});

describe("pathToNode", () => {
  it("returns the full root→node path for a top-level node", () => {
    expect(pathToNode(buildTree(), L("garage"))).toEqual([L("garage")]);
  });
  it("returns the full chain for a deeply nested node (drill fix)", () => {
    // bin1 is a grandchild of garage — the path must include the intermediate
    // ancestor, not skip it.
    expect(pathToNode(buildTree(), L("bin1"))).toEqual([
      L("garage"),
      L("shelfA"),
      L("bin1"),
    ]);
  });
  it("returns [] for a missing node", () => {
    expect(pathToNode(buildTree(), L("nope"))).toEqual([]);
  });
});

describe("findUnknownRoot", () => {
  it("finds the top-level Unknown", () => {
    expect(findUnknownRoot(buildTree())?.id).toBe(L("unknown"));
  });
  it("returns null when absent", () => {
    expect(findUnknownRoot([loc("garage", "Garage")])).toBeNull();
  });
  it("ignores a nested location named Unknown", () => {
    const t = [loc("garage", "Garage", [loc("u2", "Unknown")])];
    // nested Unknown has a parent in the real tree; our fixture has no parent
    // field, but it isn't a root, so findUnknownRoot won't return it.
    expect(findUnknownRoot(t)).toBeNull();
  });
});

describe("isSelfOrDescendant", () => {
  it("is true for self", () => {
    expect(isSelfOrDescendant(buildTree(), L("garage"), L("garage"))).toBe(
      true,
    );
  });
  it("is true for a deep descendant", () => {
    expect(isSelfOrDescendant(buildTree(), L("garage"), L("bin1"))).toBe(true);
  });
  it("is false for an unrelated node", () => {
    expect(isSelfOrDescendant(buildTree(), L("garage"), L("pantry"))).toBe(
      false,
    );
  });
});

describe("isValidLocationDrop", () => {
  it("rejects dropping onto self", () => {
    expect(isValidLocationDrop(buildTree(), L("garage"), L("garage"))).toBe(
      false,
    );
  });
  it("rejects dropping onto a descendant (cycle)", () => {
    expect(isValidLocationDrop(buildTree(), L("garage"), L("bin1"))).toBe(
      false,
    );
  });
  it("rejects dropping onto the current parent (no-op)", () => {
    expect(isValidLocationDrop(buildTree(), L("shelfA"), L("garage"))).toBe(
      false,
    );
  });
  it("rejects dragging the Unknown root", () => {
    expect(isValidLocationDrop(buildTree(), L("unknown"), L("garage"))).toBe(
      false,
    );
  });
  it("accepts a valid cross-subtree reparent", () => {
    expect(isValidLocationDrop(buildTree(), L("shelfA"), L("kitchen"))).toBe(
      true,
    );
  });
  it("accepts drop-on-Home for a nested node", () => {
    expect(isValidLocationDrop(buildTree(), L("shelfA"), null)).toBe(true);
  });
  it("rejects drop-on-Home for an already-top-level node", () => {
    expect(isValidLocationDrop(buildTree(), L("garage"), null)).toBe(false);
  });
});

describe("isValidItemDrop", () => {
  it("rejects a same-location move", () => {
    expect(isValidItemDrop(L("shelfA"), L("shelfA"))).toBe(false);
  });
  it("accepts a cross-location move", () => {
    expect(isValidItemDrop(L("shelfA"), L("shelfB"))).toBe(true);
  });
});

describe("canDropOnArrangeTarget", () => {
  const locationDrag = (locationId: string) => ({
    arrangeDrag: "location",
    locationId: L(locationId),
    parentId: null,
  });
  const itemDrag = (sourceLocationId: string) => ({
    arrangeDrag: "item",
    inventoryEntryId: I("i1"),
    amount: { value: 1, unit: "count" },
    sourceLocationId: L(sourceLocationId),
  });

  it("applies cycle and same-parent rules to every location target", () => {
    expect(
      canDropOnArrangeTarget(buildTree(), L("bin1"), locationDrag("garage")),
    ).toBe(false);
    expect(
      canDropOnArrangeTarget(buildTree(), L("garage"), locationDrag("shelfA")),
    ).toBe(false);
  });

  it("allows nested locations, but not items, to move to the root target", () => {
    expect(
      canDropOnArrangeTarget(buildTree(), null, locationDrag("shelfA")),
    ).toBe(true);
    expect(canDropOnArrangeTarget(buildTree(), null, itemDrag("shelfA"))).toBe(
      false,
    );
  });

  it("allows cross-location item moves and rejects same-location no-ops", () => {
    expect(
      canDropOnArrangeTarget(buildTree(), L("shelfB"), itemDrag("shelfA")),
    ).toBe(true);
    expect(
      canDropOnArrangeTarget(buildTree(), L("shelfA"), itemDrag("shelfA")),
    ).toBe(false);
  });
});

describe("applyLocationMove", () => {
  it("moves a node under a new parent", () => {
    const next = applyLocationMove(buildTree(), L("shelfA"), L("kitchen"));
    expect(parentIdOf(next, L("shelfA"))).toBe(L("kitchen"));
    // gone from the old parent
    expect(
      findNode(next, L("garage"))?.children?.some((c) => c.id === L("shelfA")),
    ).toBe(false);
    // subtree came along
    expect(findNode(next, L("bin1"))?.name).toBe("Bin 1");
  });
  it("moves a node to top level with null parent", () => {
    const next = applyLocationMove(buildTree(), L("shelfA"), null);
    expect(parentIdOf(next, L("shelfA"))).toBeNull();
    expect(next.some((r) => r.id === L("shelfA"))).toBe(true);
  });
  it("does not mutate the input", () => {
    const t = buildTree();
    const snapshot = JSON.stringify(t);
    applyLocationMove(t, L("shelfA"), L("kitchen"));
    expect(JSON.stringify(t)).toBe(snapshot);
  });
});

describe("applyItemMove", () => {
  it("moves an item to the target location", () => {
    const next = applyItemMove(buildTree(), I("i1"), L("shelfA"), L("shelfB"));
    expect(findNode(next, L("shelfA"))?.inventoryItems?.length).toBe(0);
    expect(
      findNode(next, L("shelfB"))?.inventoryItems?.map((i) => i.id),
    ).toContain(I("i1"));
  });
  it("does not mutate the input", () => {
    const t = buildTree();
    const snapshot = JSON.stringify(t);
    applyItemMove(t, I("i1"), L("shelfA"), L("shelfB"));
    expect(JSON.stringify(t)).toBe(snapshot);
  });
});

describe("childrenOf", () => {
  it("returns roots for an empty path", () => {
    expect(childrenOf(buildTree(), []).map((n) => n.id)).toEqual([
      L("garage"),
      L("kitchen"),
      L("unknown"),
    ]);
  });
  it("returns children at a nested path", () => {
    expect(
      childrenOf(buildTree(), [L("garage"), L("shelfA")]).map((n) => n.id),
    ).toEqual([L("bin1")]);
  });
  it("returns [] when the path breaks", () => {
    expect(childrenOf(buildTree(), [L("garage"), L("nope")])).toEqual([]);
  });
});
