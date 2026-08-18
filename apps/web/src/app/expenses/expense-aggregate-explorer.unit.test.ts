import type { ExpenseAnalyticsOut } from "@cubby/schemas/project";
import { describe, expect, it } from "vitest";
import { buildExpenseExplorerModel } from "./expense-aggregate-explorer";

const analytics = {
  summary: {
    actual: 150,
    committed: 50,
    credits: 10,
    net: 190,
    count: 5,
    actualCount: 4,
    plannedCount: 1,
  },
  adjustments: { actual: 10, committed: 0, credits: 0, net: 10, count: 1 },
  byTrade: [
    {
      trade: "electrical",
      actual: 140,
      committed: 50,
      credits: 10,
      net: 180,
      count: 4,
    },
  ],
  byCostType: [
    {
      costType: "materials",
      actual: 140,
      committed: 50,
      credits: 10,
      net: 180,
      count: 4,
    },
  ],
  tradeCostMatrix: [
    {
      trade: "electrical",
      costType: "materials",
      actual: 140,
      committed: 50,
      credits: 10,
      net: 180,
      count: 4,
    },
  ],
  monthly: [
    {
      month: "2026-02",
      actual: 120,
      committed: 50,
      credits: 10,
      net: 160,
      count: 4,
    },
  ],
  cumulative: [{ month: "2026-02", cumulativeNet: 160 }],
  byProject: [
    {
      projectId: "PROJ-1",
      projectName: "Kitchen",
      actual: 100,
      committed: 50,
      credits: 10,
      net: 140,
      count: 3,
    },
  ],
  byVendor: [
    {
      vendorId: "VEND-1",
      vendorName: "Supply House",
      actual: 130,
      committed: 50,
      credits: 10,
      net: 170,
      count: 4,
    },
  ],
} as ExpenseAnalyticsOut;

describe("buildExpenseExplorerModel", () => {
  it("keeps principal dimensions complete and reconciles adjustments", () => {
    const model = buildExpenseExplorerModel(analytics, "trade");
    expect(model.rows[0]).toMatchObject({
      label: "Electrical & Lighting",
      ledgerFilter: { trade: "electrical" },
    });
    expect(model.tail).toEqual({
      label: "Purchase adjustments",
      actual: 10,
      committed: 0,
      credits: 0,
      net: 10,
      count: 1,
    });
  });

  it("reports unattributed project and vendor tails without unknown buckets", () => {
    expect(buildExpenseExplorerModel(analytics, "project").tail).toMatchObject({
      label: "Unattributed to a project",
      net: 50,
      count: 2,
    });
    expect(buildExpenseExplorerModel(analytics, "vendor").tail).toMatchObject({
      label: "Unattributed to a vendor",
      net: 20,
      count: 1,
    });
  });

  it("turns a complete monthly bucket into an exact shared ledger date scope", () => {
    const model = buildExpenseExplorerModel(analytics, "month");
    expect(model.rows[0]?.ledgerFilter).toEqual({
      dateFrom: "2026-02-01",
      dateTo: "2026-02-28",
    });
    expect(model.tail).toMatchObject({ label: "Undated spend", net: 30 });
  });

  it("keeps the existing trade by cost-type pivot navigable", () => {
    expect(
      buildExpenseExplorerModel(analytics, "tradeCost").rows[0],
    ).toMatchObject({
      label: "Electrical & Lighting · Materials",
      ledgerFilter: { trade: "electrical", costType: "materials" },
    });
  });
});
