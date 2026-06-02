import { describe, expect, it } from "vitest";
import { tryFormatAmount } from "./format-amount";

/**
 * The parser's internal "whole" unit (its sentinel for a bare count, e.g. "2"
 * eggs) renders unit-less: `Display for Measure` omits the unit when it's
 * Unit::Whole, so `wasm.format_amount({ 2, "whole" })` -> "2".
 */
describe("tryFormatAmount — bare-count ('whole') rendering", () => {
  it("renders a whole-unit amount with no unit", () => {
    expect(tryFormatAmount({ value: 2, unit: "whole" })).toBe("2");
  });

  it("renders real units normally (control)", () => {
    expect(tryFormatAmount({ value: 2, unit: "g" })).toBe("2 g");
  });

  it('keeps "each" as the user typed it', () => {
    // "each" parses to Unit::Whole (rendered unit-less); tryFormatAmount
    // re-attaches the user's "each".
    expect(tryFormatAmount({ value: 3, unit: "each" })).toBe("3 each");
  });
});
