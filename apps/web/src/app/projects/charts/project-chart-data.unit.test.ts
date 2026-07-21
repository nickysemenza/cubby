import type { PurchaseOut } from "@cubby/schemas/project";
import { describe, expect, it } from "vitest";
import {
  buildCumulativeSpendPoints,
  buildProjectMonthlySeries,
  buildPurchaseCalendar,
  buildStackedCumulativeSpend,
} from "./project-chart-data";

const purchase = (id: string, overrides: Partial<PurchaseOut>): PurchaseOut =>
  ({
    id,
    name: id,
    date: null,
    cost: null,
    costType: "materials",
    projectName: null,
    ...overrides,
  }) as unknown as PurchaseOut;

describe("buildPurchaseCalendar", () => {
  it("groups dated costs and preserves negative adjustments", () => {
    const result = buildPurchaseCalendar([
      purchase("a", { date: "2026-01-03", cost: 12 }),
      purchase("b", { date: "2026-01-03", cost: -2 }),
      purchase("c", { date: "2025-12-31", cost: 5 }),
      purchase("missing-cost", { date: "2026-01-04" }),
      purchase("zero-cost", { date: "2026-01-05", cost: 0 }),
    ]);

    expect(result.from).toBe("2025-12-31");
    expect(result.to).toBe("2026-01-03");
    expect(result.data).toEqual(
      expect.arrayContaining([
        { day: "2026-01-03", value: 10 },
        { day: "2025-12-31", value: 5 },
      ]),
    );
    expect(result.itemsByDay.get("2026-01-03")?.map(({ id }) => id)).toEqual([
      "a",
      "b",
    ]);
    expect(result.itemsByDay.has("2026-01-05")).toBe(false);
  });
});

describe("buildCumulativeSpendPoints", () => {
  it("sorts chronologically and accumulates refunds", () => {
    expect(
      buildCumulativeSpendPoints([
        purchase("later", { date: "2026-02-01", cost: -20 }),
        purchase("first", { date: "2026-01-01", cost: 100 }),
        purchase("undated", { cost: 999 }),
      ]),
    ).toEqual([
      { x: "2026-01-01", y: 100 },
      { x: "2026-02-01", y: 80 },
    ]);
  });
});

describe("monthly purchase series", () => {
  const purchases = [
    purchase("a", {
      date: "2026-01-01",
      cost: 10,
      costType: "materials",
      projectName: "Kitchen",
    }),
    purchase("b", {
      date: "2026-02-01",
      cost: 4,
      costType: "materials",
      projectName: "Kitchen",
    }),
    purchase("c", {
      date: "2026-02-02",
      cost: 7,
      costType: "tools",
      projectName: null,
    }),
  ];

  it("builds cumulative category totals across every month", () => {
    expect(
      buildStackedCumulativeSpend(purchases, (purchase) => purchase.costType),
    ).toEqual([
      {
        id: "materials",
        data: [
          { x: "Jan 26", y: 10 },
          { x: "Feb 26", y: 14 },
        ],
      },
      {
        id: "tools",
        data: [
          { x: "Jan 26", y: 0 },
          { x: "Feb 26", y: 7 },
        ],
      },
    ]);
  });

  it("builds period project totals and an Unassigned group", () => {
    expect(buildProjectMonthlySeries(purchases)).toEqual([
      {
        id: "Kitchen",
        data: [
          { x: "Jan 26", y: 10 },
          { x: "Feb 26", y: 4 },
        ],
      },
      {
        id: "Unassigned",
        data: [
          { x: "Jan 26", y: 0 },
          { x: "Feb 26", y: 7 },
        ],
      },
    ]);
  });

  it("returns no trend for empty data or a single month", () => {
    expect(buildProjectMonthlySeries([])).toEqual([]);
    expect(buildProjectMonthlySeries(purchases.slice(0, 1))).toEqual([]);
    expect(
      buildStackedCumulativeSpend(
        purchases.slice(0, 1),
        (purchase) => purchase.costType,
      ),
    ).toHaveLength(1);
  });
});
