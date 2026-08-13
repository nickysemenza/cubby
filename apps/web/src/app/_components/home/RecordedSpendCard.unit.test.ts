import type { ExpenseMonthlyAggregate } from "@cubby/schemas/project";
import { describe, expect, it } from "vitest";
import {
  fillRecordedSpendMonths,
  getRecordedSpendWindow,
} from "./RecordedSpendCard";

function month(
  key: string,
  net: number,
  overrides: Partial<ExpenseMonthlyAggregate> = {},
): ExpenseMonthlyAggregate {
  return {
    month: key,
    actual: net,
    committed: 0,
    credits: 0,
    net,
    count: 1,
    ...overrides,
  };
}

describe("recorded spend home signal", () => {
  it("requests six local calendar months of recorded expenses only", () => {
    const window = getRecordedSpendWindow(new Date(2026, 7, 12, 9));

    expect(window.months).toEqual([
      "2026-03",
      "2026-04",
      "2026-05",
      "2026-06",
      "2026-07",
      "2026-08",
    ]);
    expect(window.filters).toEqual({
      dateFrom: "2026-03-01",
      dateTo: "2026-08-31",
      future: false,
    });
  });

  it("zero-fills missing months without changing refunds or adjustments", () => {
    const result = fillRecordedSpendMonths(
      [month("2026-03", 240), month("2026-05", -45, { credits: -45 })],
      ["2026-03", "2026-04", "2026-05"],
    );

    expect(
      result.map(({ month: key, net, count }) => ({ key, net, count })),
    ).toEqual([
      { key: "2026-03", net: 240, count: 1 },
      { key: "2026-04", net: 0, count: 0 },
      { key: "2026-05", net: -45, count: 1 },
    ]);
  });
});
