import { entityFieldEnvelopeSchemas } from "@cubby/schemas/entity-field-envelopes";
import type { ProductCategoryFeature } from "@cubby/schemas/product-category";
import { describe, expect, it } from "vitest";

import { fieldValueFixture } from "~/entity/fields/field-envelope.fixtures";

import { buildCategoryHierarchy } from "./category-tree";

type Cat = Parameters<typeof buildCategoryHierarchy>[0][number];
const cat = (
  id: string,
  feature: ProductCategoryFeature | null = null,
  children?: Cat[],
): Cat => ({
  id,
  name: id,
  fields: {
    effectiveFeature: fieldValueFixture(
      entityFieldEnvelopeSchemas.productCategory.list.shape.fields.shape
        .effectiveFeature,
      feature,
    ),
  },
  ...(children ? { subRows: children } : {}),
});

describe("buildCategoryHierarchy", () => {
  it("rolls direct counts up and inherits the closest feature", () => {
    const root = buildCategoryHierarchy(
      [cat("tools", "tools", [cat("hw", null, [cat("screws")])])],
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
