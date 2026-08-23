import { describe, expect, it } from "vitest";
import { resolveScanCode } from "./scan-code";

describe("resolveScanCode", () => {
  it.each([
    ["PRD-4K7M", "PRD-4K7M", "product"],
    [" prd-4k7m ", "PRD-4K7M", "product"],
    ["https://cubby.nickysemenza.com/LOC-4K7M", "LOC-4K7M", "location"],
    ["https://cubby.nickysemenza.com/L-4K7M", "LOC-4K7M", "location"],
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
    if (!result.ok) expect(result.error).toContain(message);
  });
});
