import { describe, expect, it } from "vitest";

import { deriveCollectionMembership } from "./collection-membership";

const product = (id: string, tags: string[] = []) => ({ id, tags });
const location = (
  id: string,
  parentId: string | null,
  tags: string[] = [],
  productId: string | null = null,
) => ({ id, parentId, tags, productId });

describe("deriveCollectionMembership", () => {
  it("distinguishes direct, inherited, and combined membership", () => {
    const graph = deriveCollectionMembership({
      products: [product("paint", ["collection:painting"]), product("brush")],
      locations: [
        location("shop", null, ["collection:painting"]),
        location("cabinet", "shop", ["collection:painting"]),
      ],
      inventory: [{ productId: "brush", locationId: "cabinet" }],
    });

    expect(graph.locationInherited.get("shop")).toEqual(new Set());
    expect(graph.locationInherited.get("cabinet")).toEqual(
      new Set(["painting"]),
    );
    expect(graph.productInherited.get("brush")).toEqual(new Set(["painting"]));
  });

  it("recomputes after subtree moves and ignores deleted rows supplied by the caller", () => {
    const products = [product("saw")];
    const inventory = [{ productId: "saw", locationId: "shelf" }];
    const inWoodshop = deriveCollectionMembership({
      products,
      locations: [
        location("woodshop", null, ["collection:woodworking"]),
        location("garage", null),
        location("shelf", "woodshop"),
      ],
      inventory,
    });
    const moved = deriveCollectionMembership({
      products,
      locations: [
        location("woodshop", null, ["collection:woodworking"]),
        location("garage", null),
        location("shelf", "garage"),
      ],
      inventory,
    });

    expect(inWoodshop.productInherited.get("saw")?.has("woodworking")).toBe(
      true,
    );
    expect(moved.productInherited.get("saw")?.has("woodworking") ?? false).toBe(
      false,
    );
  });

  it("excludes a product-backed container while including its contents", () => {
    const graph = deriveCollectionMembership({
      products: [product("tote"), product("brush")],
      locations: [
        location("studio", null, ["collection:painting"]),
        location("tote-location", "studio", [], "tote"),
      ],
      inventory: [
        { productId: "brush", locationId: "studio" },
        { productId: "brush", locationId: "tote-location" },
      ],
    });

    expect(graph.productInherited.get("tote")).toBeUndefined();
    expect(graph.productInherited.get("brush")).toEqual(new Set(["painting"]));
  });
});
