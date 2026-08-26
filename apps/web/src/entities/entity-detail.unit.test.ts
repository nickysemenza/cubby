import { unsafeProductShortcode } from "@cubby/schemas/identifiers";
import { describe, expect, it } from "vitest";
import {
  EntityDetailError,
  entityDetailQueryKey,
  entityDetailQueryOptions,
  entityDetailRootKey,
} from "./entity-detail.functions";

describe("entity detail transport contract", () => {
  it("uses the normalized operation detail query key", () => {
    expect(
      entityDetailQueryKey("product", unsafeProductShortcode("PRD-4K7M")),
    ).toEqual([
      "operation",
      "entity.detail",
      {
        entity: "product",
        input: { entity: "product", shortcode: "PRD-4K7M" },
      },
    ]);
    expect(entityDetailRootKey("product")).toEqual([
      "operation",
      "entity.detail",
    ]);
  });

  it("stores physical-label aliases under canonical detail keys", () => {
    expect(entityDetailQueryKey("product", "p-4k7m")).toEqual([
      "operation",
      "entity.detail",
      {
        entity: "product",
        input: { entity: "product", shortcode: "PRD-4K7M" },
      },
    ]);
    expect(entityDetailQueryKey("location", "L-4K7M")).toEqual([
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
      entityDetailQueryOptions("product", "", { enabled: false }),
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
