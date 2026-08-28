import { describe, expect, it } from "vitest";

import {
  resolveLocationScan,
  resolveProductScan,
  resolveScanCode,
} from "./scan-code";

describe("resolveScanCode", () => {
  it.each([
    ["PRD-4K7M", "PRD-4K7M", "product"],
    [" prd-4k7m ", "PRD-4K7M", "product"],
    ["https://cubby.example.com/LOC-4K7M", "LOC-4K7M", "location"],
    ["https://cubby.example.com/L-4K7M", "LOC-4K7M", "location"],
  ])("resolves the Cubby label %s", (raw, shortcode, type) => {
    expect(resolveScanCode(raw)).toEqual({
      ok: true,
      value: { kind: "shortcode", shortcode, type },
    });
  });

  it.each(["0-306-40615-2", "978-0-306-40615-7", "9780306406157"])(
    "normalizes ISBN %s before generic EAN handling",
    (raw) => {
      expect(resolveScanCode(raw)).toEqual({
        ok: true,
        value: {
          kind: "product",
          code: { kind: "isbn", value: "09780306406157" },
        },
      });
    },
  );

  it.each(["012345678905", "4006381333932", "12345670", "12345678901234"])(
    "accepts product barcode %s",
    (raw) => {
      expect(resolveScanCode(raw)).toEqual({
        ok: true,
        value: { kind: "product", code: { kind: "barcode", value: raw } },
      });
    },
  );

  it("keeps a non-ISBN EAN-13 in the barcode lane", () => {
    expect(resolveScanCode("4006381333931")).toEqual({
      ok: true,
      value: {
        kind: "product",
        code: { kind: "barcode", value: "4006381333931" },
      },
    });
  });

  it.each([
    ["", "Enter or scan"],
    ["not a code", "Use a Cubby shortcode"],
    ["https://example.com/page", "not a Cubby label"],
  ])("rejects unsupported input %j", (raw, message) => {
    expect(resolveScanCode(raw)).toMatchObject({ ok: false });
    const result = resolveScanCode(raw);
    // oxlint-disable-next-line vitest/no-conditional-expect -- The data-dependent branch determines whether this optional case is applicable.
    if (!result.ok) expect(result.error).toContain(message);
  });
});

describe("resolveLocationScan", () => {
  it.each([
    ["LOC-4K7M", "LOC-4K7M"],
    [" loc-4k7m ", "LOC-4K7M"],
    ["https://cubby.example.com/LOC-4K7M", "LOC-4K7M"],
    ["https://cubby.example.com/L-4K7M", "LOC-4K7M"],
  ])("accepts the location label %s", (raw, shortcode) => {
    expect(resolveLocationScan(raw)).toEqual({ ok: true, value: shortcode });
  });

  it("names what was scanned, not just what was wanted", () => {
    expect(resolveLocationScan("PRD-4K7M")).toEqual({
      ok: false,
      reason: "wrong-kind",
      error: "That's a product label — point at a location QR.",
    });
    expect(resolveLocationScan("012345678905")).toEqual({
      ok: false,
      reason: "wrong-kind",
      error: "That's a product barcode — point at a location QR.",
    });
  });

  it("passes through the resolver's own rejection", () => {
    expect(resolveLocationScan("not a code")).toEqual({
      ok: false,
      reason: "unrecognized",
      error: "Use a Cubby shortcode, UPC/EAN/GTIN barcode, or valid ISBN.",
    });
  });
});

describe("resolveProductScan", () => {
  it("accepts a printed Cubby product label", () => {
    expect(resolveProductScan("PRD-4K7M")).toEqual({
      ok: true,
      value: { kind: "product", value: "PRD-4K7M" },
    });
  });

  it.each([
    ["012345678905", { kind: "barcode", value: "012345678905" }],
    ["9780306406157", { kind: "isbn", value: "09780306406157" }],
  ])("accepts the external code %s", (raw, code) => {
    expect(resolveProductScan(raw)).toEqual({ ok: true, value: code });
  });

  it("rejects a non-stockable label by naming its kind", () => {
    expect(resolveProductScan("RCP-4K7M")).toEqual({
      ok: false,
      reason: "wrong-kind",
      error: "That's a recipe label — nothing that sits on a shelf.",
    });
  });

  /**
   * The sweep routes location codes itself now. Guards the copy that named a
   * "bin scanner" which never existed anywhere in the app.
   */
  it("no longer sends location labels to an imaginary bin scanner", () => {
    const result = resolveProductScan("LOC-4K7M");
    expect(result.ok).toBe(false);
    // oxlint-disable-next-line vitest/no-conditional-expect -- The data-dependent branch determines whether this optional case is applicable.
    if (!result.ok) expect(result.error).not.toContain("bin scanner");
  });
});
