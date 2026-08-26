import { err, ok } from "neverthrow";
import { describe, expect, it } from "vitest";
import {
  computeScalingPercentages,
  formatScalingPct,
  pickDefaultBaseRowId,
} from "./recipe-scaling-pct";

type ScalingCosting = Parameters<typeof pickDefaultBaseRowId>[0];
type ScalingRow = ScalingCosting["rows"][number];

const mkRow = (id: string, grams: number | null): ScalingRow => ({
  id,
  priceInfo: {
    gram: grams == null ? err("no weight") : ok({ value: grams, unit: "g" }),
    price: err("n/a"),
    nutrient: err("n/a"),
  },
});

const mkCosting = (
  rows: ScalingRow[],
  flourIds: string[] = [],
): ScalingCosting => ({
  rows,
  isFlourRows: new Map(rows.map((r) => [r.id, flourIds.includes(r.id)])),
});

describe("pickDefaultBaseRowId", () => {
  it("prefers flour even when it isn't the heaviest", () => {
    const costing = mkCosting(
      [mkRow("flour", 100), mkRow("sugar", 200)],
      ["flour"],
    );
    expect(pickDefaultBaseRowId(costing)).toBe("flour");
  });

  it("falls back to the heaviest row when there's no flour", () => {
    const costing = mkCosting([
      mkRow("a", 50),
      mkRow("b", 120),
      mkRow("c", null),
    ]);
    expect(pickDefaultBaseRowId(costing)).toBe("b");
  });

  it("returns null when no row has resolvable grams", () => {
    const costing = mkCosting([mkRow("a", null), mkRow("b", null)]);
    expect(pickDefaultBaseRowId(costing)).toBeNull();
  });
});

describe("computeScalingPercentages", () => {
  it("scales every row against the base's grams (base = 100%)", () => {
    const costing = mkCosting([
      mkRow("flour", 100),
      mkRow("sugar", 200),
      mkRow("butter", 50),
      mkRow("water", null),
    ]);
    const pct = computeScalingPercentages(costing, "flour");
    expect(pct.get("flour")).toBe(100);
    expect(pct.get("sugar")).toBe(200);
    expect(pct.get("butter")).toBe(50);
    expect(pct.get("water")).toBeNull();
  });

  it("re-anchors when a different base is chosen", () => {
    const costing = mkCosting([mkRow("flour", 100), mkRow("sugar", 200)]);
    const pct = computeScalingPercentages(costing, "sugar");
    expect(pct.get("sugar")).toBe(100);
    expect(pct.get("flour")).toBe(50);
  });

  it("yields all-null when the base has no grams or is missing", () => {
    const costing = mkCosting([mkRow("a", null), mkRow("b", 100)]);
    expect(computeScalingPercentages(costing, "a").get("b")).toBeNull();
    expect(computeScalingPercentages(costing, null).get("b")).toBeNull();
  });
});

describe("formatScalingPct", () => {
  it("uses one decimal below 10% and whole percent at/above", () => {
    expect(formatScalingPct(100)).toBe("100%");
    expect(formatScalingPct(25)).toBe("25%");
    expect(formatScalingPct(15)).toBe("15%");
    expect(formatScalingPct(7.5)).toBe("7.5%");
    expect(formatScalingPct(0.56)).toBe("0.6%");
    expect(formatScalingPct(1.25)).toBe("1.3%");
  });
});
