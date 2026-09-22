import type {
  InfLocation,
  InventoryItemForTree,
} from "@cubby/schemas/location";
import { infLocation } from "@cubby/schemas/location";
import { testCompleteDataQuality, testShortcode } from "@cubby/schemas/testing";
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
  return infLocation.parse({
    id: testShortcode("location", id),
    name,
    aliases: [],
    type: null,
    product: null,
    lastBulkInventory: null,
    aiDescription: null,
    notes: null,
    images: [],
    valuation: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    dataQuality: testCompleteDataQuality(),
    children,
    inventoryItems: items,
  });
}

function item(id: string, productId: string): InventoryItemForTree {
  const parsed = infLocation.parse({
    id: testShortcode("location", `item-${id}`),
    name: "fixture location",
    aliases: [],
    type: null,
    product: null,
    lastBulkInventory: null,
    aiDescription: null,
    notes: null,
    images: [],
    valuation: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    dataQuality: testCompleteDataQuality(),
    inventoryItems: [
      {
        id: testShortcode("inventory", id),
        amount: { value: 1, unit: "count" },
        productName: `p-${productId}`,
        productId: testShortcode("product", productId),
      },
    ],
  });
  const [inventoryItem] = parsed.inventoryItems ?? [];
  if (!inventoryItem) throw new Error("fixture inventory item was not parsed");
  return inventoryItem;
}

const L = (id: string) => testShortcode("location", id);
const I = (id: string) => testShortcode("inventory", id);

// Home → [garage → [shelfA → [bin1], shelfB], kitchen → [pantry], Unknown]
function buildTree(): InfLocation[] {
  return [
    loc("home", "Home", [
      loc("garage", "Garage", [
        loc("shelfA", "Shelf A", [loc("bin1", "Bin 1")], [item("i1", "prodX")]),
        loc("shelfB", "Shelf B"),
      ]),
      loc("kitchen", "Kitchen", [loc("pantry", "Pantry")]),
      loc("unknown", "Unknown"),
    ]),
  ];
}

describe("findNode / parentIdOf", () => {
  it("finds a deeply nested node", () => {
    expect(findNode(buildTree(), L("bin1"))?.name).toBe("Bin 1");
  });
  it("returns null for a missing node", () => {
    expect(findNode(buildTree(), L("nope"))).toBeNull();
  });
  it("returns the parent id, null only for Home", () => {
    const t = buildTree();
    expect(parentIdOf(t, L("bin1"))).toBe(L("shelfA"));
    expect(parentIdOf(t, L("shelfA"))).toBe(L("garage"));
    expect(parentIdOf(t, L("garage"))).toBe(L("home"));
    expect(parentIdOf(t, L("home"))).toBeNull();
  });
});

describe("pathToNode", () => {
  it("returns the full Home→node path", () => {
    expect(pathToNode(buildTree(), L("garage"))).toEqual([
      L("home"),
      L("garage"),
    ]);
  });
  it("returns the full chain for a deeply nested node (drill fix)", () => {
    // bin1 is a grandchild of garage — the path must include the intermediate
    // ancestor, not skip it.
    expect(pathToNode(buildTree(), L("bin1"))).toEqual([
      L("home"),
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
  it("finds Unknown nested under Home", () => {
    expect(findUnknownRoot(buildTree())?.id).toBe(L("unknown"));
  });
  it("returns null when absent", () => {
    expect(
      findUnknownRoot([loc("home", "Home", [loc("garage", "Garage")])]),
    ).toBeNull();
  });
  it("finds Unknown at any depth", () => {
    const t = [
      loc("home", "Home", [loc("garage", "Garage", [loc("u2", "Unknown")])]),
    ];
    expect(findUnknownRoot(t)?.id).toBe(L("u2"));
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
  it("rejects dragging the Unknown staging location", () => {
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
    expect(isValidLocationDrop(buildTree(), L("shelfA"), L("home"))).toBe(true);
  });
  it("rejects dropping a direct Home child onto Home", () => {
    expect(isValidLocationDrop(buildTree(), L("garage"), L("home"))).toBe(
      false,
    );
  });
  it("rejects reparenting Home", () => {
    expect(isValidLocationDrop(buildTree(), L("home"), L("garage"))).toBe(
      false,
    );
  });
});

describe("isValidItemDrop", () => {
  it("rejects a same-location move", () => {
    expect(isValidItemDrop(buildTree(), L("shelfA"), L("shelfA"))).toBe(false);
  });
  it("accepts a cross-location move", () => {
    expect(isValidItemDrop(buildTree(), L("shelfA"), L("shelfB"))).toBe(true);
  });
  it("rejects moving an item into Home", () => {
    expect(isValidItemDrop(buildTree(), L("shelfA"), L("home"))).toBe(false);
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

  it("allows locations, but not items, to move onto Home", () => {
    expect(
      canDropOnArrangeTarget(buildTree(), L("home"), locationDrag("shelfA")),
    ).toBe(true);
    expect(
      canDropOnArrangeTarget(buildTree(), L("home"), itemDrag("shelfA")),
    ).toBe(false);
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
  it("moves a node under Home", () => {
    const next = applyLocationMove(buildTree(), L("shelfA"), L("home"));
    expect(parentIdOf(next, L("shelfA"))).toBe(L("home"));
    expect(
      findNode(next, L("home"))?.children?.some((r) => r.id === L("shelfA")),
    ).toBe(true);
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
  it("returns Home for an empty path", () => {
    expect(childrenOf(buildTree(), []).map((n) => n.id)).toEqual([L("home")]);
  });
  it("returns children at a nested path", () => {
    expect(
      childrenOf(buildTree(), [L("home"), L("garage"), L("shelfA")]).map(
        (n) => n.id,
      ),
    ).toEqual([L("bin1")]);
  });
  it("returns [] when the path breaks", () => {
    expect(
      childrenOf(buildTree(), [L("home"), L("garage"), L("nope")]),
    ).toEqual([]);
  });
});
