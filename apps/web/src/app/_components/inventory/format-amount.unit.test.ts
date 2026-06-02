import { describe, expect, it } from "vitest";
import { tryFormatAmount } from "./format-amount";

/**
 * CHARACTERIZATION TESTS — these document CURRENT, intentionally-wrong behavior.
 *
 * The parser's internal "whole" unit (its sentinel for a bare count, e.g. "2"
 * eggs) leaks into formatted amounts as the literal word "whole". The proper fix
 * lives in the ingredient-parser repo's `Display for Measure` (omit the unit when
 * it's Unit::Whole), after which `wasm.format_amount({ 2, "whole" })` -> "2".
 *
 * When that lands and the WASM is rebuilt, the first assertion below WILL FAIL —
 * that's intentional. Flip it to the fixed value ("2") then. See the plan:
 * "outstanding nits" / deferred ingredient-parser session.
 */
describe("tryFormatAmount — 'whole' unit leak (characterization)", () => {
  it('currently renders a whole-unit amount with the literal "whole"', () => {
    // TODO(whole): should become "2" once ingredient-parser drops the unit.
    expect(tryFormatAmount({ value: 2, unit: "whole" })).toBe("2 whole");
  });

  it("renders real units normally (control)", () => {
    expect(tryFormatAmount({ value: 2, unit: "g" })).toBe("2 g");
  });

  it('keeps "each" as the user typed it (existing behavior)', () => {
    // tryFormatAmount swaps WASM's normalized "whole" back to "each".
    expect(tryFormatAmount({ value: 3, unit: "each" })).toBe("3 each");
  });
});
