import { describe, expect, it } from "vitest";
import { parsePastedShortcode } from "./pasted-shortcode";

describe("parsePastedShortcode", () => {
  it("recognizes a canonical shortcode pasted into an empty command search", () => {
    expect(
      parsePastedShortcode({
        currentValue: "",
        pastedText: " prd-4k7m\n",
        selectionStart: 0,
        selectionEnd: 0,
      }),
    ).toEqual({
      type: "product",
      shortcode: "PRD-4K7M",
      legacy: false,
    });
  });

  it("canonicalizes a legacy shortcode that replaces selected search text", () => {
    expect(
      parsePastedShortcode({
        currentValue: "old search",
        pastedText: "p-4k7m",
        selectionStart: 0,
        selectionEnd: 10,
      }),
    ).toEqual({
      type: "product",
      shortcode: "PRD-4K7M",
      legacy: true,
    });
  });

  it("does not capture a shortcode pasted into surrounding search text", () => {
    expect(
      parsePastedShortcode({
        currentValue: "find  please",
        pastedText: "PRD-4K7M",
        selectionStart: 5,
        selectionEnd: 5,
      }),
    ).toBeNull();
  });

  it("does not capture an incomplete shortcode", () => {
    expect(
      parsePastedShortcode({
        currentValue: "",
        pastedText: "PRD-4K7",
        selectionStart: 0,
        selectionEnd: 0,
      }),
    ).toBeNull();
  });
});
