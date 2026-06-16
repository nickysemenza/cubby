import { describe, expect, it } from "vitest";
import { foodLookupParamFromProduct } from "./product";

describe("product repository helpers", () => {
  describe("foodLookupParamFromProduct", () => {
    it("returns an FDC lookup when fdc_id is present", () => {
      const result = foodLookupParamFromProduct({ upc: null, fdc_id: 170859 });

      expect(result).toEqual({ kind: "fdc", fdc_id: 170859 });
    });

    it("returns a UPC lookup when fdc_id is null but UPC is present", () => {
      const result = foodLookupParamFromProduct({
        upc: "123456789012",
        fdc_id: null,
      });

      expect(result).toEqual({ kind: "upc", gtin_upc: "123456789012" });
    });

    it("returns null when both fdc_id and UPC are null", () => {
      const result = foodLookupParamFromProduct({ upc: null, fdc_id: null });

      expect(result).toBeNull();
    });

    it("prioritizes the explicit fdc_id over UPC auto-resolution", () => {
      // A branded product (UPC) that the user has explicitly linked to a richer
      // reference food: the fdc_id link must win.
      const result = foodLookupParamFromProduct({
        upc: "123456789012",
        fdc_id: 170859,
      });

      expect(result).toEqual({ kind: "fdc", fdc_id: 170859 });
    });
  });
});
