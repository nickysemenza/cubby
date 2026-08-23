import { describe, expect, it } from "vitest";
import { allocateWeightedCents } from "./allocation";

describe("allocateWeightedCents", () => {
  it("uses a stable target-key tie break for leftover cents", () => {
    const rows = allocateWeightedCents(10n, [
      { key: "c", target: "c", weight: 1 },
      { key: "a", target: "a", weight: 1 },
      { key: "b", target: "b", weight: 1 },
    ]);
    expect(
      Object.fromEntries(rows.map((row) => [row.target, row.cents])),
    ).toEqual({
      a: 4n,
      b: 3n,
      c: 3n,
    });
  });

  it("allocates refunds with the same magnitudes and a negative sign", () => {
    const rows = allocateWeightedCents(-5n, [
      { key: "a", target: "a", weight: 1 },
      { key: "b", target: "b", weight: 1 },
    ]);
    expect(rows).toEqual([
      { target: "a", cents: -3n },
      { target: "b", cents: -2n },
    ]);
    expect(rows.reduce((total, row) => total + row.cents, 0n)).toBe(-5n);
  });

  it("rejects non-positive or fractional weights", () => {
    expect(() =>
      allocateWeightedCents(1n, [{ key: "x", target: "x", weight: 0 }]),
    ).toThrow("positive integers");
    expect(() =>
      allocateWeightedCents(1n, [{ key: "x", target: "x", weight: 1.5 }]),
    ).toThrow("positive integers");
  });
});
