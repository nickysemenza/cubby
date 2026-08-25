import { unsafeProductShortcode } from "@cubby/schemas/identifiers";
import { describe, expect, it } from "vitest";
import {
  EntityDetailError,
  entityDetailQueryKey,
  entityDetailRootKey,
} from "./entity-detail.functions";

describe("entity detail transport contract", () => {
  it("keeps the former tRPC-compatible nested detail key", () => {
    expect(
      entityDetailQueryKey("product", unsafeProductShortcode("PRD-4K7M")),
    ).toEqual([["product", "detail"], { shortcode: "PRD-4K7M" }]);
    expect(entityDetailRootKey("product")).toEqual([["product", "detail"]]);
  });

  it("stores physical-label aliases under canonical detail keys", () => {
    expect(entityDetailQueryKey("product", "p-4k7m")).toEqual([
      ["product", "detail"],
      { shortcode: "PRD-4K7M" },
    ]);
    expect(entityDetailQueryKey("location", "L-4K7M")).toEqual([
      ["location", "detail"],
      { shortcode: "LOC-4K7M" },
    ]);
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
