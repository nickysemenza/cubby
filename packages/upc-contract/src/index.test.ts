import { describe, expect, it } from "vitest";
import {
  bulkLookupRequestSchema,
  productLookupResponseSchema,
  upcLookupInput,
  upcSearchInput,
} from "./index";

describe("UPC transport contract", () => {
  it("normalizes valid lookup and search inputs", () => {
    expect(upcLookupInput.parse({ upc: "012345678905" })).toEqual({
      upc: "012345678905",
    });
    expect(upcSearchInput.parse({ query: "coffee" })).toEqual({
      query: "coffee",
      limit: 20,
    });
  });

  it("rejects invalid bounds at the shared boundary", () => {
    // oxlint-disable-next-line vitest/require-to-throw-message -- The rejection itself is contractual; the exact message is intentionally not.
    expect(() => upcSearchInput.parse({ query: "", limit: 0 })).toThrow();
    // oxlint-disable-next-line vitest/require-to-throw-message -- The rejection itself is contractual; the exact message is intentionally not.
    expect(() => bulkLookupRequestSchema.parse({ upcs: [] })).toThrow();
    expect(
      () =>
        bulkLookupRequestSchema.parse({
          upcs: Array.from({ length: 201 }, () => "1"),
        }),
      // oxlint-disable-next-line vitest/require-to-throw-message -- The rejection itself is contractual; the exact message is intentionally not.
    ).toThrow();
  });

  it("validates the cached product response shape", () => {
    expect(
      productLookupResponseSchema.parse({
        upc: "012345678905",
        name: "Coffee",
        manufacturer: null,
        brand: null,
        category: null,
        description: null,
        priceDollars: null,
        imageUrl: null,
        source: "manual",
        cached: true,
      }),
    ).toMatchObject({ name: "Coffee", cached: true });
  });
});
