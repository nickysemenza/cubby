import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { householdLocalDate } from "~/lib/household-date";

import { projectDashboardSummary } from "./project/dashboard-summary";
import { projectList } from "./project/lookup";
import { projectPortfolioAnalytics } from "./project/portfolio-analytics";
import { loadRelatedPreviews } from "./related-view";
import { insertWithShortcode } from "./shortcode-utils";

describe("project dashboard attribution", () => {
  const ctx = withTestDb();

  it("sorts by the displayed subtree start while respecting descendant overrides", async () => {
    const early = await insertWithShortcode(ctx.db, "project", {
      name: "Sort early",
    });
    const middle = await insertWithShortcode(ctx.db, "project", {
      name: "Sort middle",
      startDate: "2026-01-02",
    });
    const late = await insertWithShortcode(ctx.db, "project", {
      name: "Sort late",
    });
    const earlyChild = await insertWithShortcode(ctx.db, "project", {
      name: "Early child",
      parentProjectId: early.id,
    });
    const lateChild = await insertWithShortcode(ctx.db, "project", {
      name: "Late child",
      parentProjectId: late.id,
      startDate: "2026-01-03",
    });
    const grandchild = await insertWithShortcode(ctx.db, "project", {
      name: "Grandchild",
      parentProjectId: lateChild.id,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Sort vendor",
    });
    for (const [owner, date] of [
      [earlyChild.id, "2026-01-01"],
      [grandchild.id, "2025-01-01"],
    ] as const) {
      const purchase = await insertWithShortcode(ctx.db, "purchase", {
        vendorId: vendor.id,
        date,
        defaultProjectId: owner,
        defaultTrade: "building",
      });
      await insertWithShortcode(ctx.db, "expense", {
        name: "Inherited date",
        purchaseId: purchase.id,
        date,
        cost: 1,
        costType: "materials",
        lineKind: "principal",
      });
    }
    const rows = await projectList(
      ctx.db,
      { search: "Sort " },
      [{ orderBy: "startDate", direction: "asc" }],
      { pageIndex: 0, pageSize: 20 },
    );
    expect(rows.data.map((row) => row.id)).toEqual([
      early.shortcode,
      middle.shortcode,
      late.shortcode,
    ]);
    expect(rows.data.map((row) => row.dates.effectiveStart)).toEqual([
      "2026-01-01",
      "2026-01-02",
      "2026-01-03",
    ]);
  });

  it("does not count a scoped grandchild twice when its intermediate parent is filtered out", async () => {
    const root = await insertWithShortcode(ctx.db, "project", {
      name: "Included root",
    });
    const middle = await insertWithShortcode(ctx.db, "project", {
      name: "Hidden middle",
      parentProjectId: root.id,
    });
    const leaf = await insertWithShortcode(ctx.db, "project", {
      name: "Included leaf",
      parentProjectId: middle.id,
    });
    await insertWithShortcode(ctx.db, "expense", {
      name: "Leaf cost",
      projectId: leaf.id,
      date: "2026-01-01",
      cost: 10,
      trade: "building",
      costType: "materials",
      lineKind: "principal",
    });
    const result = await projectPortfolioAnalytics(ctx.db, {
      search: "Included",
    });
    expect(
      result.costVsEstimate
        .filter((row) => row.isScopeRoot)
        .map((row) => row.projectId),
    ).toEqual([root.shortcode]);
    expect(
      result.costVsEstimate
        .filter((row) => row.isScopeRoot)
        .reduce((sum, row) => sum + row.actual, 0),
    ).toBe(10);
  });

  it("uses inherited site names and allocates shared charges before narrowing the dashboard", async () => {
    const parent = await insertWithShortcode(ctx.db, "project", {
      name: "Site parent",
      locations: ["Test room"],
      locationsMode: "explicit",
      defaultTrade: "building",
    });
    const first = await insertWithShortcode(ctx.db, "project", {
      name: "Scoped child",
      parentProjectId: parent.id,
      locationsMode: "inherit",
      status: "in_progress",
    });
    const second = await insertWithShortcode(ctx.db, "project", {
      name: "Other project",
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Attribution vendor",
    });
    const date = householdLocalDate();
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      defaultProjectId: first.id,
      defaultTrade: "building",
      date,
    });
    for (const [name, cost, projectId] of [
      ["First item", 2, null],
      ["Second item", 8, second.id],
    ] as const) {
      await insertWithShortcode(ctx.db, "expense", {
        name,
        cost,
        projectId,
        purchaseId: purchase.id,
        date,
        future: true,
        costType: "materials",
        lineKind: "principal",
      });
    }
    const tax = await insertWithShortcode(ctx.db, "expense", {
      name: "Shared tax",
      cost: 1,
      purchaseId: purchase.id,
      date,
      future: true,
      costType: "services",
      lineKind: "tax",
    });
    const relations = await loadRelatedPreviews(ctx.db, {
      source: "project",
      sourceIds: [first.shortcode, second.shortcode],
      relationKeys: ["project.expenses"],
    });
    expect(relations).toHaveLength(2);
    for (const relation of relations) {
      expect(relation.totalCount).toBe(2);
      expect(relation.items.map((item) => item.id)).toContain(tax.shortcode);
    }
    const result = await projectDashboardSummary(ctx.db, {
      search: "Scoped child",
      locations: ["Test room"],
      dateFrom: date,
      dateTo: date,
    });
    expect(result.projects.map((row) => row.id)).toEqual([first.shortcode]);
    expect(result.projects[0]?.locations).toEqual(["Test room"]);
    expect(result.summary.committedSpend).toBe(2.2);
    expect(result.summary.forwardCommittedSpend).toEqual({
      in30Days: 2.2,
      in60Days: 2.2,
      in90Days: 2.2,
    });
    expect(result.filterOptions.locations).toContain("Test room");
  });
});
