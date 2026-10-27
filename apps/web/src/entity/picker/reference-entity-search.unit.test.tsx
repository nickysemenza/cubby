import { entityFieldEnvelopeSchemas } from "@cubby/schemas/entity-field-envelopes";
import { testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";

import { fieldValueFixture } from "~/entity/fields/field-envelope.fixtures";

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
    fields: {
      path: fieldValueFixture(
        entityFieldEnvelopeSchemas.productCategory.list.shape.fields.shape[
          "path"
        ],
        [{ id: rootId, name: "Apparel" }],
      ),
    },
    id: rootId,
    name: "Apparel",
    parentId: null,
    aliases: [],
    description: null,
  },
  {
    fields: {
      path: fieldValueFixture(
        entityFieldEnvelopeSchemas.productCategory.list.shape.fields.shape[
          "path"
        ],
        [
          { id: rootId, name: "Apparel" },
          { id: groupId, name: "Outerwear" },
        ],
      ),
    },
    id: groupId,
    name: "Outerwear",
    parentId: rootId,
    aliases: [],
    description: null,
  },
  {
    fields: {
      path: fieldValueFixture(
        entityFieldEnvelopeSchemas.productCategory.list.shape.fields.shape[
          "path"
        ],
        [
          { id: rootId, name: "Apparel" },
          { id: groupId, name: "Outerwear" },
          { id: leafId, name: "Rain shell" },
        ],
      ),
    },
    id: leafId,
    name: "Rain shell",
    parentId: groupId,
    aliases: ["waterproof jacket"],
    description: "Outer layer for wet weather.",
  },
  {
    fields: {
      path: fieldValueFixture(
        entityFieldEnvelopeSchemas.productCategory.list.shape.fields.shape[
          "path"
        ],
        [{ id: toolsId, name: "Tools" }],
      ),
    },
    id: toolsId,
    name: "Tools",
    parentId: null,
    aliases: [],
    description: null,
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
    // Regression: `name` is the full path — it is what the closed control
    // displays after a pick, so a leaf-only name showed "Rain shell" where
    // the product had read "Apparel / Outerwear / Rain shell". The row
    // itself renders the node label.
    expect(items.map((item) => item.name)).toEqual([
      "Apparel",
      "Apparel / Outerwear",
      "Apparel / Outerwear / Rain shell",
      "Tools",
    ]);
    expect(items.map((item) => item.presentation?.rowLabel)).toEqual([
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
