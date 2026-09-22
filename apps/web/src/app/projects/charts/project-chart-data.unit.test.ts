import { type ExpenseOut, expenseOut } from "@cubby/schemas/project";
import { testCompleteDataQuality, testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";

import {
  buildCumulativeSpendPoints,
  buildExpenseCalendar,
  buildStackedCumulativeSpend,
} from "./project-chart-data";

const expense = (id: string, overrides: Partial<ExpenseOut>): ExpenseOut =>
  expenseOut.parse({
    id: testShortcode("expense", `EXP-${id}`),
    name: id,
    date: null,
    cost: null,
    costType: "materials",
    lineKind: "principal",
    lineBasis: "item_line",
    trade: "other",
    future: false,
    vendor: null,
    vendorId: null,
    vendorLogo: null,
    projectId: null,
    productId: null,
    productName: null,
    productQuantity: null,
    purchaseId: null,
    purchaseDate: null,
    purchaseDisplayLabel: null,
    orderId: null,
    orderUrl: null,
    notes: null,
    url: null,
    projectName: null,
    beneficiaries: [],
    funders: [],
    sourceClaims: [],
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    dataQuality: testCompleteDataQuality(),
    ...overrides,
  });

describe("buildExpenseCalendar", () => {
  it("groups dated costs and preserves negative adjustments", () => {
    const result = buildExpenseCalendar([
      expense("a", { date: "2026-01-03", cost: 12 }),
      expense("b", { date: "2026-01-03", cost: -2 }),
      expense("c", { date: "2025-12-31", cost: 5 }),
      expense("missing-cost", { date: "2026-01-04" }),
      expense("zero-cost", { date: "2026-01-05", cost: 0 }),
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
      testShortcode("expense", "EXP-a"),
      testShortcode("expense", "EXP-b"),
    ]);
    expect(result.itemsByDay.has("2026-01-05")).toBe(false);
  });
});

describe("buildCumulativeSpendPoints", () => {
  it("sorts chronologically and accumulates refunds", () => {
    expect(
      buildCumulativeSpendPoints([
        expense("later", { date: "2026-02-01", cost: -20 }),
        expense("first", { date: "2026-01-01", cost: 100 }),
      ]),
    ).toEqual([
      { x: "2026-01-01", y: 100 },
      { x: "2026-02-01", y: 80 },
    ]);
  });
});

describe("monthly expense series", () => {
  const expenses = [
    expense("a", {
      date: "2026-01-01",
      cost: 10,
      costType: "materials",
      projectName: "Kitchen",
    }),
    expense("b", {
      date: "2026-02-01",
      cost: 4,
      costType: "materials",
      projectName: "Kitchen",
    }),
    expense("c", {
      date: "2026-02-02",
      cost: 7,
      costType: "tools",
      projectName: null,
    }),
  ];

  it("builds cumulative category totals across every month", () => {
    expect(
      buildStackedCumulativeSpend(expenses, (expense) => expense.costType),
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

  it("returns a single-group trend for a single month", () => {
    expect(
      buildStackedCumulativeSpend(
        expenses.slice(0, 1),
        (expense) => expense.costType,
      ),
    ).toHaveLength(1);
  });
});
