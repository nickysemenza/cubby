import type { WIngredient } from "@cubby/recipebridge";
import type { Amount } from "@cubby/schemas/codec";
import { describe, expect, it } from "vitest";
import { amountsEqual, computeParseDrift, hasDrift } from "./parse-drift";

// Minimal fresh-parse builder — only the fields computeParseDrift reads.
const fresh = (
  name: string,
  amounts: { value: number; unit: string; upper_value?: number }[] = [],
  modifier?: string,
): Pick<WIngredient, "name" | "amounts" | "modifier"> => ({
  name,
  amounts,
  modifier,
});

describe("amountsEqual", () => {
  it("compares value + unit per element in order", () => {
    expect(
      amountsEqual(
        [{ value: 1, unit: "clove" }],
        [{ value: 1, unit: "clove" }],
      ),
    ).toBe(true);
    expect(
      amountsEqual([{ value: 1, unit: "whole" }], [{ value: 1, unit: "head" }]),
    ).toBe(false);
    expect(
      amountsEqual(
        [{ value: 1, unit: "clove" }],
        [{ value: 2, unit: "clove" }],
      ),
    ).toBe(false);
  });

  it("differs on length", () => {
    expect(amountsEqual([], [{ value: 1, unit: "clove" }])).toBe(false);
    expect(amountsEqual([{ value: 1, unit: "clove" }], [])).toBe(false);
  });

  it("ignores upper_value (never persisted)", () => {
    const stored: Amount[] = [{ value: 2, unit: "clove" }];
    expect(
      amountsEqual(stored, [{ value: 2, unit: "clove", upper_value: 3 }]),
    ).toBe(true);
  });
});

describe("computeParseDrift", () => {
  const persisted = (
    knownNames: string[],
    amounts: Amount[],
    modifier: string | null = null,
  ) => ({ knownNames, amounts, modifier });

  it("flags the {1, whole} -> {1, head} amount case with no name drift", () => {
    // The garlic-head bug: merged ingredient name matches, but the amount drifted.
    const drift = computeParseDrift(
      persisted(["garlic"], [{ value: 1, unit: "whole" }]),
      fresh("garlic", [{ value: 1, unit: "head" }]),
    );
    expect(drift.name).toBeNull();
    expect(drift.amounts).toEqual([{ value: 1, unit: "head" }]);
    expect(hasDrift(drift)).toBe(true);
  });

  it("flags name drift", () => {
    const drift = computeParseDrift(
      persisted(["garlic clove"], [{ value: 1, unit: "clove" }]),
      fresh("garlic", [{ value: 1, unit: "clove" }]),
    );
    expect(drift.name).toBe("garlic");
    expect(drift.amounts).toBeNull();
    expect(hasDrift(drift)).toBe(true);
  });

  it("treats an alias hit as no drift (case-insensitive)", () => {
    const drift = computeParseDrift(
      persisted(["large brown egg", "Egg"], [{ value: 2, unit: "whole" }]),
      fresh("egg", [{ value: 2, unit: "whole" }]),
    );
    expect(drift.name).toBeNull();
    expect(hasDrift(drift)).toBe(false);
  });

  it("flags modifier-only drift", () => {
    const drift = computeParseDrift(
      persisted(["onion"], [{ value: 1, unit: "cup" }], "chopped"),
      fresh("onion", [{ value: 1, unit: "cup" }], "finely chopped"),
    );
    expect(drift.name).toBeNull();
    expect(drift.amounts).toBeNull();
    expect(drift.modifier).toBe("finely chopped");
    expect(hasDrift(drift)).toBe(true);
  });

  it("represents a modifier removed as '' (drift), distinct from null", () => {
    const drift = computeParseDrift(
      persisted(["onion"], [{ value: 1, unit: "cup" }], "chopped"),
      fresh("onion", [{ value: 1, unit: "cup" }], undefined),
    );
    expect(drift.modifier).toBe("");
    expect(hasDrift(drift)).toBe(true);
  });

  it("is all-clear when name, amounts, and modifier match", () => {
    const drift = computeParseDrift(
      persisted(["garlic"], [{ value: 1, unit: "clove" }], "peeled"),
      fresh("garlic", [{ value: 1, unit: "clove" }], "peeled"),
    );
    expect(drift).toEqual({ name: null, amounts: null, modifier: null });
    expect(hasDrift(drift)).toBe(false);
  });
});
