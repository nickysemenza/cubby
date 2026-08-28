import { testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";

import { EntityDetailError, entityDetailFor } from "./entity-detail.functions";

describe("entity detail transport contract", () => {
  it("uses the normalized operation detail query key", () => {
    expect(
      entityDetailFor("product").queryKey(testShortcode("product", "PRD-4K7M")),
    ).toEqual([
      "operation",
      "entity.detail",
      {
        entity: "product",
        input: { entity: "product", shortcode: "PRD-4K7M" },
      },
    ]);
  });

  it("stores physical-label aliases under canonical detail keys", () => {
    expect(entityDetailFor("product").queryKey("p-4k7m")).toEqual([
      "operation",
      "entity.detail",
      {
        entity: "product",
        input: { entity: "product", shortcode: "PRD-4K7M" },
      },
    ]);
    expect(entityDetailFor("location").queryKey("L-4K7M")).toEqual([
      "operation",
      "entity.detail",
      {
        entity: "location",
        input: { entity: "location", shortcode: "LOC-4K7M" },
      },
    ]);
  });

  it("allows an empty placeholder while a conditional query is disabled", () => {
    expect(() =>
      entityDetailFor("product").queryOptions("", { enabled: false }),
    ).not.toThrow();
  });

  it("exposes neutral error details to existing browser error handling", () => {
    const error = new EntityDetailError({
      code: "NOT_FOUND",
      reason: "PRODUCT_NOT_FOUND",
      message: "Product not found",
    });

    expect(error).toMatchObject({
      message: "Product not found",
      data: { code: "NOT_FOUND", reason: "PRODUCT_NOT_FOUND" },
    });
  });
});
