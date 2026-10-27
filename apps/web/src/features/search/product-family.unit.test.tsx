import {
  searchInventoryPlacementSchema,
  searchResultGroupSchema,
} from "@cubby/schemas/search";
import { testShortcode } from "@cubby/schemas/testing";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { fieldValueFixture } from "~/entity/fields/field-envelope.fixtures";

import {
  ProductFamilyChildContent,
  productFamilyChildren,
} from "./product-family";

const product = testShortcode("product", "PRD-4K7M");
const placement = {
  id: testShortcode("inventory", "INV-4K7M"),
  locationPath: "Synthetic room › Shelf",
  placement: "stock",
  fields: {
    locationId: fieldValueFixture(
      searchInventoryPlacementSchema.shape.fields.shape.locationId,
      testShortcode("location", "LOC-4K7M"),
    ),
    amount: fieldValueFixture(
      searchInventoryPlacementSchema.shape.fields.shape.amount,
      undefined,
    ),
  },
};

describe("Product family current placement values", () => {
  it("keeps a missing amount unavailable while retaining the destination and location evidence", () => {
    const hit = {
      id: product,
      entityKind: "product",
      title: "Synthetic wrench",
      subtitle: null,
      typeHint: null,
      imageUrl: null,
      matchKind: "exact",
      matchField: "title",
      matchReason: "Synthetic match",
      matchTerms: ["wrench"],
    };
    const missing = searchInventoryPlacementSchema.parse({
      ...placement,
      fields: {
        ...placement.fields,
        amount: {
          ...placement.fields.amount,
          work: {
            kind: "failed",
            error: "Synthetic placement amount unavailable",
            retryAt: null,
          },
        },
      },
    });
    const group = searchResultGroupSchema.parse({
      kind: "product",
      key: product,
      primary: hit,
      bestMatch: hit,
      placements: [missing],
      componentPlacements: [],
      matchedActivity: [],
    });
    if (group.kind !== "product")
      throw new Error("Synthetic product group required");
    const child = productFamilyChildren(group).children[0];
    if (!child) throw new Error("Synthetic placement child required");
    expect(child.destination.id).toBe(placement.id);
    render(<ProductFamilyChildContent child={child} />);
    expect(screen.getByText("Synthetic room › Shelf")).toBeVisible();
    expect(screen.getByText("Unavailable")).toBeVisible();
    expect(
      screen.getByLabelText("Synthetic placement amount unavailable"),
    ).toBeVisible();
    expect(screen.queryByText("0 each")).not.toBeInTheDocument();
  });
});
