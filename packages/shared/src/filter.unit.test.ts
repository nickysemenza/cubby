import { describe, expect, it } from "vitest";

import {
  formatNumberBound,
  formatRangeBounds,
  parseNumberBound,
  parseNumberRangeBounds,
} from "./filter";

describe("number range bounds", () => {
  // Failure mode: `String(0.0000001)` is `1e-7`, which the decoder read as
  // no bound, so a typed tiny or huge bound silently dropped the filter.
  it.each([
    0,
    1.5,
    -2.5,
    0.0000001,
    1.5e-10,
    0.1 + 0.2,
    123456789,
    1e21,
    1.5e300,
  ])("round-trips %s through the URL value", (value) => {
    const text = formatNumberBound(value);
    expect(text).not.toMatch(/e/i);
    const url = formatRangeBounds(text, text) ?? "";
    expect(parseNumberRangeBounds(url, {})).toEqual({
      min: value,
      max: value,
    });
  });

  it.each([
    ["1.", {}],
    ["abc", {}],
    ["9".repeat(309), {}],
    ["-1", { nonnegative: true }],
    ["1.5", { int: true }],
    ["9007199254740993", { int: true }],
  ] as const)("rejects %s under %o", (text, range) => {
    expect(parseNumberBound(text, range)).toBeUndefined();
  });
});
