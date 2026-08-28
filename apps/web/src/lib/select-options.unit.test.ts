import { describe, expect, it } from "vitest";

import { buildSelectOptions } from "./select-options";

describe("buildSelectOptions", () => {
  it("maps each value to its label in order", () => {
    const values = ["a", "b"] as const;
    const labels = { a: "Alpha", b: "Beta" };
    expect(buildSelectOptions(values, labels)).toEqual([
      { value: "a", label: "Alpha" },
      { value: "b", label: "Beta" },
    ]);
  });

  it("returns an empty array for an empty enum", () => {
    expect(buildSelectOptions([], {})).toEqual([]);
  });
});
