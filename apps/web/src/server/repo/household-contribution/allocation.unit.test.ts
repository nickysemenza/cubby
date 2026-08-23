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

  it.each([
    ["large cost", 9_000_000_000_000_001n],
    ["large refund", -9_000_000_000_000_001n],
  ])("keeps %s exact at maximum valid weights", (_label, totalCents) => {
    const rows = allocateWeightedCents(totalCents, [
      { key: "a", target: "a", weight: 2_147_483_647 },
      { key: "b", target: "b", weight: 2_147_483_646 },
    ]);

    expect(rows.reduce((total, row) => total + row.cents, 0n)).toBe(totalCents);
    if (totalCents < 0n) {
      expect(rows[0]?.cents).toBeLessThan(0n);
      expect(rows[1]?.cents).toBeLessThan(0n);
    } else {
      expect(rows[0]?.cents).toBeGreaterThan(0n);
      expect(rows[1]?.cents).toBeGreaterThan(0n);
    }
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
