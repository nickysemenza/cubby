import { testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";

import {
  productCategorySearchItems,
  type ProductCategoryRow,
} from "./reference-entity-search";

const rootId = testShortcode("productCategory", "CAT-1ABC");
const groupId = testShortcode("productCategory", "CAT-2ABC");
const leafId = testShortcode("productCategory", "CAT-3ABC");
const toolsId = testShortcode("productCategory", "CAT-4ABC");

const categories: ProductCategoryRow[] = [
  {
    id: rootId,
    name: "Apparel",
    parentId: null,
    aliases: [],
    description: null,
    path: [{ id: rootId, name: "Apparel" }],
  },
  {
    id: groupId,
    name: "Outerwear",
    parentId: rootId,
    aliases: [],
    description: null,
    path: [
      { id: rootId, name: "Apparel" },
      { id: groupId, name: "Outerwear" },
    ],
  },
  {
    id: leafId,
    name: "Rain shell",
    parentId: groupId,
    aliases: ["waterproof jacket"],
    description: "Outer layer for wet weather.",
    path: [
      { id: rootId, name: "Apparel" },
      { id: groupId, name: "Outerwear" },
      { id: leafId, name: "Rain shell" },
    ],
  },
  {
    id: toolsId,
    name: "Tools",
    parentId: null,
    aliases: [],
    description: null,
    path: [{ id: toolsId, name: "Tools" }],
  },
];

describe("productCategorySearchItems", () => {
  it("emits a depth-first, grouped tree on an empty query", () => {
    const items = productCategorySearchItems(categories, "");

    expect(items.map((item) => item.id)).toEqual([
      rootId,
      groupId,
      leafId,
      toolsId,
    ]);
    expect(items.map((item) => item.presentation?.depth)).toEqual([0, 1, 2, 0]);
    expect(items.map((item) => item.name)).toEqual([
      "Apparel",
      "Outerwear",
      "Rain shell",
      "Tools",
    ]);
  });

  it("emits flat full-path rows once a query is typed", () => {
    const items = productCategorySearchItems(categories, "rain");

    expect(items).toEqual([
      expect.objectContaining({
        id: leafId,
        name: "Apparel / Outerwear / Rain shell",
      }),
    ]);
    // No tree presentation on the flat search path.
    expect(items[0]?.presentation).toBeUndefined();
  });

  it("matches a query against aliases and description, not just name", () => {
    expect(
      productCategorySearchItems(categories, "waterproof").map((i) => i.id),
    ).toEqual([leafId]);
    expect(
      productCategorySearchItems(categories, "wet weather").map((i) => i.id),
    ).toEqual([leafId]);
  });
});
