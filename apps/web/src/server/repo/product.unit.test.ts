import { describe, expect, it } from "vitest";
import { foodLookupParamFromProduct } from "./product";

describe("product repository helpers", () => {
  describe("foodLookupParamFromProduct", () => {
    it("returns UPC lookup when UPC is present", () => {
      const product = { upc: "123456789012", ndb_number: null };
      const result = foodLookupParamFromProduct(product);

      expect(result).toEqual({
        kind: "upc",
        gtin_upc: "123456789012",
      });
    });

    it("returns NDB lookup when UPC is null but NDB is present", () => {
      const product = { upc: null, ndb_number: 12345 };
      const result = foodLookupParamFromProduct(product);

      expect(result).toEqual({
        kind: "ndb",
        ndb_number: 12345,
      });
    });

    it("returns null when both UPC and NDB are null", () => {
      const product = { upc: null, ndb_number: null };
      const result = foodLookupParamFromProduct(product);

      expect(result).toBeNull();
    });

    it("prioritizes UPC over NDB when both are present", () => {
      const product = { upc: "123456789012", ndb_number: 12345 };
      const result = foodLookupParamFromProduct(product);

      expect(result).toEqual({
        kind: "upc",
        gtin_upc: "123456789012",
      });
    });
  });
});
