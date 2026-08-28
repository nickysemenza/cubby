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
  // `a` is persisted (Amount, camel `upperValue`); `b` is the fresh parse
  // (WAmount, snake `upper_value`).
  type Persisted = { value: number; unit: string; upperValue?: number }[];
  type Fresh = { value: number; unit: string; upper_value?: number }[];
  const CASES: { name: string; a: Persisted; b: Fresh; expected: boolean }[] = [
    {
      name: "equal value + unit",
      a: [{ value: 1, unit: "clove" }],
      b: [{ value: 1, unit: "clove" }],
      expected: true,
    },
    {
      name: "differing unit",
      a: [{ value: 1, unit: "whole" }],
      b: [{ value: 1, unit: "head" }],
      expected: false,
    },
    {
      name: "differing value",
      a: [{ value: 1, unit: "clove" }],
      b: [{ value: 2, unit: "clove" }],
      expected: false,
    },
    {
      name: "differing length (empty vs one)",
      a: [],
      b: [{ value: 1, unit: "clove" }],
      expected: false,
    },
    {
      name: "differing length (one vs empty)",
      a: [{ value: 1, unit: "clove" }],
      b: [],
      expected: false,
    },
    {
      name: "matching range upper bound is equal",
      a: [{ value: 2, unit: "clove", upperValue: 3 }],
      b: [{ value: 2, unit: "clove", upper_value: 3 }],
      expected: true,
    },
    {
      name: "legacy row missing the upper bound drifts",
      a: [{ value: 2, unit: "clove" }],
      b: [{ value: 2, unit: "clove", upper_value: 3 }],
      expected: false,
    },
    {
      name: "differing upper bound drifts",
      a: [{ value: 2, unit: "clove", upperValue: 4 }],
      b: [{ value: 2, unit: "clove", upper_value: 3 }],
      expected: false,
    },
  ];

  it.each(CASES)("$name", ({ a, b, expected }) => {
    expect(amountsEqual(a, b)).toBe(expected);
  });
});

describe("computeParseDrift", () => {
  const persisted = (
    knownNames: string[],
    amounts: Amount[],
    modifier: string | null = null,
  ) => ({ knownNames, amounts, modifier });

  type Drift = ReturnType<typeof computeParseDrift>;
  interface Case {
    name: string;
    persisted: {
      knownNames: string[];
      amounts: Amount[];
      modifier?: string | null;
    };
    fresh: {
      name: string;
      amounts?: { value: number; unit: string; upper_value?: number }[];
      modifier?: string;
    };
    expectedDrift: Drift;
    expectedHasDrift: boolean;
  }

  const CASES: Case[] = [
    {
      // The garlic-head bug: merged ingredient name matches, but amount drifted.
      name: "amount drift {1, whole} → {1, head} with no name drift",
      persisted: {
        knownNames: ["garlic"],
        amounts: [{ value: 1, unit: "whole" }],
      },
      fresh: { name: "garlic", amounts: [{ value: 1, unit: "head" }] },
      expectedDrift: {
        name: null,
        amounts: [{ value: 1, unit: "head" }],
        modifier: null,
      },
      expectedHasDrift: true,
    },
    {
      name: "name drift",
      persisted: {
        knownNames: ["garlic clove"],
        amounts: [{ value: 1, unit: "clove" }],
      },
      fresh: { name: "garlic", amounts: [{ value: 1, unit: "clove" }] },
      expectedDrift: { name: "garlic", amounts: null, modifier: null },
      expectedHasDrift: true,
    },
    {
      name: "alias hit is no drift (case-insensitive)",
      persisted: {
        knownNames: ["large brown egg", "Egg"],
        amounts: [{ value: 2, unit: "whole" }],
      },
      fresh: { name: "egg", amounts: [{ value: 2, unit: "whole" }] },
      expectedDrift: { name: null, amounts: null, modifier: null },
      expectedHasDrift: false,
    },
    {
      name: "modifier-only drift",
      persisted: {
        knownNames: ["onion"],
        amounts: [{ value: 1, unit: "cup" }],
        modifier: "chopped",
      },
      fresh: {
        name: "onion",
        amounts: [{ value: 1, unit: "cup" }],
        modifier: "finely chopped",
      },
      expectedDrift: { name: null, amounts: null, modifier: "finely chopped" },
      expectedHasDrift: true,
    },
    {
      // A removed modifier is '' (drift), distinct from null (no modifier change).
      name: "modifier removed → '' drift",
      persisted: {
        knownNames: ["onion"],
        amounts: [{ value: 1, unit: "cup" }],
        modifier: "chopped",
      },
      fresh: {
        name: "onion",
        amounts: [{ value: 1, unit: "cup" }],
        modifier: undefined,
      },
      expectedDrift: { name: null, amounts: null, modifier: "" },
      expectedHasDrift: true,
    },
    {
      name: "all-clear when name, amounts, and modifier match",
      persisted: {
        knownNames: ["garlic"],
        amounts: [{ value: 1, unit: "clove" }],
        modifier: "peeled",
      },
      fresh: {
        name: "garlic",
        amounts: [{ value: 1, unit: "clove" }],
        modifier: "peeled",
      },
      expectedDrift: { name: null, amounts: null, modifier: null },
      expectedHasDrift: false,
    },
  ];

  it.each(CASES)("$name", (c) => {
    const drift = computeParseDrift(
      persisted(
        c.persisted.knownNames,
        c.persisted.amounts,
        c.persisted.modifier,
      ),
      fresh(c.fresh.name, c.fresh.amounts, c.fresh.modifier),
    );
    expect(drift).toEqual(c.expectedDrift);
    expect(hasDrift(drift)).toBe(c.expectedHasDrift);
  });
});
