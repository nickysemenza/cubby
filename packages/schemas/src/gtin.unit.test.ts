import { describe, expect, it } from "vitest";
import { displayGtin, gtin, isGtinKind, normalizeGtin } from "./external-id";

describe("barcode canonicalization", () => {
  // The bug this migration exists to close: `Product_upc_key` compared the
  // stored strings, so a 12-digit UPC-A and its 13-digit reprint were two
  // different values and one real item existed twice (PRD 774cdbbd/4182d4c9).
  it("collapses every encoding of one barcode to a single key", () => {
    expect(normalizeGtin("077089850017")).toBe("00077089850017");
    expect(normalizeGtin("0077089850017")).toBe("00077089850017");
    expect(normalizeGtin("00077089850017")).toBe("00077089850017");
    expect(normalizeGtin("12345670")).toBe("00000012345670");
  });

  // `lpad(x, 14, '0')` TRUNCATES longer input instead of erroring, so an
  // over-long value would silently become somebody else's barcode.
  it("refuses anything that is not 8-14 digits rather than truncating", () => {
    expect(normalizeGtin("012345678901234")).toBeNull();
    expect(normalizeGtin("1234567")).toBeNull();
    expect(normalizeGtin("ABC123456789")).toBeNull();
    expect(normalizeGtin("")).toBeNull();
  });

  it("normalizes on the write boundary", () => {
    expect(gtin.parse(" 077089850017 ")).toBe("00077089850017");
    expect(gtin.safeParse("12345").success).toBe(false);
    expect(gtin.safeParse("not-a-barcode").success).toBe(false);
  });

  // The operator compares this against the package, and usda-api indexes
  // `branded_food.gtin_upc` left-padded to twelve — a GTIN-14 lookup misses.
  it("renders and looks up in the printed encoding", () => {
    expect(displayGtin("00077089850017")).toBe("077089850017");
    expect(displayGtin("00000012345670")).toBe("000012345670");
    expect(displayGtin(gtin.parse("077089850017"))).toBe("077089850017");
  });

  it("recognizes only the canonical barcode kind", () => {
    expect(isGtinKind("gtin_14")).toBe(true);
    expect(isGtinKind("asin")).toBe(false);
    expect(isGtinKind("legacy_unspecified")).toBe(false);
  });
});
