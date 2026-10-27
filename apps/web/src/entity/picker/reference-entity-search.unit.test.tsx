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
