import type { ExpenseFlowSankeyOut } from "@cubby/schemas/project";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { insertAndReturn, unwrapDb } from "~/server/db/helpers";
import {
  type expense,
  expenseAttribution,
  ledgerParty,
} from "~/server/db/schema";
import { expenseAnalyzeWorkflow } from "~/server/domains/expense/operations.server";
import { loadExpenseAllocations } from "~/server/domains/household-contribution/repo/allocation";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { expenseFlowSankey } from "./flow-sankey";

const ctx = withTestDb();

const principal = (
  name: string,
  cost: number,
  links: Pick<typeof expense.$inferInsert, "projectId" | "spendingCategoryId">,
) =>
  insertWithShortcode(ctx.db, "expense", {
    name: `synthetic flow ${name}`,
    cost,
    lineKind: "principal",
    date: "2026-09-20",
    costType: "materials",
    trade: "other",
    future: false,
    ...links,
  });

const linkValue = (
  sankey: ExpenseFlowSankeyOut,
  source: string,
  target: string,
) =>
  sankey.links.find((link) => link.source === source && link.target === target)
    ?.value;

describe("expenseFlowSankey", () => {
  it("splits by funder weights, nets Credits within a path, and reconciles to the filtered net", async () => {
    const [first, second] = await Promise.all(
      ["LPY-FL01", "LPY-FL02"].map((shortcode, index) =>
        insertAndReturn(ctx.db, ledgerParty, {
          name: `Synthetic funder ${index + 1}`,
          shortcode,
          kind: "member",
        }),
      ),
    );
    if (!first || !second) throw new Error("Expected two funders");
    const renovation = await insertWithShortcode(ctx.db, "project", {
      name: "Synthetic flow project",
    });
    const home = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Synthetic flow home",
    });
    const fixtures = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Synthetic flow fixtures",
      parentId: home.id,
    });
    const travel = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Synthetic flow travel",
    });

    const shared = await principal("shared purchase", 100, {
      projectId: renovation.id,
      spendingCategoryId: fixtures.id,
    });
    const credit = await principal("credit", -30, {
      projectId: renovation.id,
      spendingCategoryId: home.id,
    });
    await principal("refund without funder", -10, {
      spendingCategoryId: travel.id,
    });
    await unwrapDb(ctx.db)
      .insert(expenseAttribution)
      .values([
        {
          expenseId: shared.id,
          role: "funder",
          ledgerPartyId: first.id,
          weight: 3,
        },
        {
          expenseId: shared.id,
          role: "funder",
          ledgerPartyId: second.id,
          weight: 1,
        },
        {
          expenseId: credit.id,
          role: "funder",
          ledgerPartyId: first.id,
          weight: 1,
        },
      ]);

    const filters = { search: "synthetic flow" };
    const sankey = await expenseFlowSankey(ctx.db, filters);
    const projectNode = `project:${renovation.shortcode}`;
    const homeNode = `spendingCategory:${home.shortcode}`;

    // 100 splits 75 / 25 by weight; the -30 Credit nets inside the first
    // funder's path rather than drawing a negative link.
    expect(linkValue(sankey, "funder:LPY-FL01", projectNode)).toBe(45);
    expect(linkValue(sankey, "funder:LPY-FL02", projectNode)).toBe(25);
    expect(linkValue(sankey, projectNode, homeNode)).toBe(70);
    expect(sankey.nonPositivePaths).toEqual([
      {
        funder: "funder:unknown",
        project: "project:none",
        category: `spendingCategory:${travel.shortcode}`,
        net: -10,
      },
    ]);

    const analysis = await expenseAnalyzeWorkflow(ctx.db, {
      filters,
      rowDimension: "trade",
      comparison: "none",
      spendingCategoryRollup: "none",
    });
    if (analysis.status !== "ready") throw new Error(analysis.status);
    const filteredNet = analysis.totals.scope.current.net;
    expect(filteredNet).toBe(60);
    expect(sankey.totals).toEqual({ net: 60, linked: 70, nonPositive: -10 });
    const columnTotal = (column: "funder" | "project") =>
      sankey.links
        .filter((link) => link.source.startsWith(`${column}:`))
        .reduce((sum, link) => sum + link.value, 0);
    expect(columnTotal("funder")).toBe(sankey.totals.linked);
    expect(columnTotal("project")).toBe(sankey.totals.linked);
    expect(
      sankey.totals.linked +
        sankey.nonPositivePaths.reduce((sum, path) => sum + path.net, 0),
    ).toBe(filteredNet);

    // Plan §6: funder links are not filterable; the Ledger has no funder filter.
    expect(
      sankey.links
        .filter((link) => link.source.startsWith("funder:"))
        .map((link) => link.filter),
    ).toEqual(
      sankey.links
        .filter((link) => link.source.startsWith("funder:"))
        .map(() => null),
    );
    expect(
      sankey.links.find((link) => link.target === homeNode)?.filter,
    ).toEqual({
      project: renovation.shortcode,
      includeSubProjects: "false",
      spendingCategory: home.shortcode,
      includeSubSpendingCategories: "true",
    });
  });

  it("keeps each Expense's ledger funder cents when one share rounds across paths", async () => {
    const funders = await Promise.all(
      ["LPY-FL11", "LPY-FL12"].map((shortcode, index) =>
        insertAndReturn(ctx.db, ledgerParty, {
          name: `Synthetic split funder ${index + 1}`,
          shortcode,
          kind: "member",
        }),
      ),
    );
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic flow vendor",
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-09-20",
    });
    for (const name of ["Synthetic split tools", "Synthetic split food"]) {
      const category = await insertWithShortcode(ctx.db, "spendingCategory", {
        name,
      });
      await insertWithShortcode(ctx.db, "expense", {
        name: `${name} line`,
        cost: 10,
        spendingCategoryId: category.id,
        purchaseId: purchase.id,
        date: "2026-09-20",
        costType: "materials",
        trade: "other",
        lineKind: "principal",
        lineBasis: "item_line",
      });
    }
    // 2 cents of tax round to 1 cent per category path.
    const tax = await insertWithShortcode(ctx.db, "expense", {
      name: "synthetic flow split tax",
      cost: 0.02,
      purchaseId: purchase.id,
      date: "2026-09-20",
      costType: "materials",
      trade: "other",
      lineKind: "tax",
    });
    await unwrapDb(ctx.db)
      .insert(expenseAttribution)
      .values(
        funders.map((funder) => ({
          expenseId: tax.id,
          role: "funder" as const,
          ledgerPartyId: funder!.id,
          weight: 1,
        })),
      );

    const ledger = (
      await loadExpenseAllocations(ctx.db, { expenseIds: [tax.id] })
    ).filter((row) => row.role === "funder");
    expect(ledger.map((row) => [row.allocationKey, row.cents]).sort()).toEqual([
      ["LPY-FL11", 1n],
      ["LPY-FL12", 1n],
    ]);

    const sankey = await expenseFlowSankey(ctx.db, {
      search: "synthetic flow split tax",
    });
    expect(linkValue(sankey, "funder:LPY-FL11", "project:none")).toBe(0.01);
    expect(linkValue(sankey, "funder:LPY-FL12", "project:none")).toBe(0.01);
    expect(sankey.totals).toEqual({ net: 0.02, linked: 0.02, nonPositive: 0 });
  });
});
