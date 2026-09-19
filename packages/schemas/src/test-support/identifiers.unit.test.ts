import { describe, expect, expectTypeOf, it } from "vitest";
import { shortcodeEntities } from "../entity-manifest";
import {
  type ProductId,
  type ProductShortcode,
  productId,
  productShortcode,
} from "../identifiers";
import { testEntityId, testShortcode } from "./identifiers";

describe("test identifier factories", () => {
  it("returns the exact entity-indexed brands", () => {
    const productIdValue: ProductId = testEntityId("product", "fixture");
    const productShortcodeValue: ProductShortcode = testShortcode(
      "product",
      "fixture",
    );

    expectTypeOf(testEntityId("product", "fixture")).toEqualTypeOf<ProductId>();
    expectTypeOf(
      testShortcode("product", "fixture"),
    ).toEqualTypeOf<ProductShortcode>();
    expect(productId.parse(productIdValue)).toBe(productIdValue);
    expect(productShortcode.parse(productShortcodeValue)).toBe(
      productShortcodeValue,
    );
  });

  it("is deterministic and emits UUIDv4 values", () => {
    const first = testEntityId("location", "same-seed");
    const second = testEntityId("location", "same-seed");
    const otherEntity = testEntityId("product", "same-seed");

    expect(first).toBe(second);
    expect(first).not.toBe(otherEntity);
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("preserves exact valid identifier literals", () => {
    const uuid = "11111111-1111-4111-8111-111111111111";
    expect(testEntityId("product", uuid)).toBe(uuid);
    expect(testShortcode("product", "PRD-4K7M")).toBe("PRD-4K7M");
  });

  it("covers every manifest entity with a valid prefixed shortcode", () => {
    for (const entity of shortcodeEntities) {
      const shortcode = testShortcode(entity, "coverage");
      expect(shortcode).toMatch(
        /^[A-Z]{2,5}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/,
      );
    }
  });

  it("keeps fixture shortcode collisions unlikely across a normal suite", () => {
    const values = Array.from({ length: 1_000 }, (_, index) =>
      testShortcode("product", `fixture-${index}`),
    );
    expect(new Set(values).size).toBe(values.length);
  });
});
