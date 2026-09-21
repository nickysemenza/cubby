import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { unwrapDb } from "~/server/repo/database-helpers";
import { loadRelatedSummary } from "~/server/repo/related-view";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import {
  expenseAllocatedCostSql,
  expenseAllocationExistsSql,
  expenseProjectAllocationSql,
  expenseProjectNamesSql,
  loadExpenseProjectAllocations,
} from "./expense-project-allocation";

describe("expense project allocation", () => {
  const ctx = withTestDb("mcp");

  it("uses the full purchase principal weights and assigns signed cents exactly", async () => {
    const [smallProject, largeProject] = await Promise.all([
      insertWithShortcode(ctx.db, "project", {
        name: "Small allocation project",
      }),
      insertWithShortcode(ctx.db, "project", {
        name: "Large allocation project",
      }),
    ]);
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Allocation fixture vendor",
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-09-20",
    });
    await Promise.all([
      insertWithShortcode(ctx.db, "expense", {
        name: "Small principal",
        cost: 10,
        date: "2026-09-20",
        lineKind: "principal",
        costType: "materials",
        trade: "other",
        future: false,
        projectId: smallProject.id,
        purchaseId: purchase.id,
      }),
      insertWithShortcode(ctx.db, "expense", {
        name: "Large principal",
        cost: 20,
        date: "2026-09-20",
        lineKind: "principal",
        costType: "materials",
        trade: "other",
        future: false,
        projectId: largeProject.id,
        purchaseId: purchase.id,
      }),
      insertWithShortcode(ctx.db, "expense", {
        name: "Known zero principal",
        cost: 0,
        date: "2026-09-20",
        lineKind: "principal",
        costType: "materials",
        trade: "other",
        future: false,
        projectId: smallProject.id,
        purchaseId: purchase.id,
      }),
    ]);
    const tax = await insertWithShortcode(ctx.db, "expense", {
      name: "Tax",
      cost: 0.05,
      date: "2026-09-20",
      lineKind: "tax",
      costType: "services",
      trade: "other",
      future: false,
      purchaseId: purchase.id,
    });

    const unrelatedPurchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-09-20",
    });
    const unrelated = await insertWithShortcode(ctx.db, "expense", {
      name: "Unrelated principal",
      cost: 100,
      date: "2026-09-20",
      lineKind: "principal",
      costType: "materials",
      trade: "other",
      future: false,
      purchaseId: unrelatedPurchase.id,
    });
    const standalone = await insertWithShortcode(ctx.db, "expense", {
      name: "Standalone credit",
      cost: -5,
      date: "2026-09-20",
      lineKind: "principal",
      costType: "materials",
      trade: "other",
      future: false,
      projectId: smallProject.id,
    });

    // A detail read must weight the whole target purchase, without resolving
    // unrelated ledger rows and holding the shared pool for ledger-wide work.
    const plan = await unwrapDb(ctx.db).execute<{ "QUERY PLAN": string }>(
      sql`EXPLAIN (ANALYZE, COSTS OFF) ${expenseProjectAllocationSql([tax.id])}`,
    );
    const planText = plan.rows.map((row) => row["QUERY PLAN"]).join("\n");
    expect(
      planText.match(/CTE principal_fact\n[^\n]*rows=(\d+) loops=1/u)?.[1],
    ).toBe("3");

    const rows = (await loadExpenseProjectAllocations(ctx.db, [tax.id])).sort(
      (a, b) => (a.projectName ?? "").localeCompare(b.projectName ?? ""),
    );

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.attributedCents).sort()).toEqual([2n, 3n]);
    expect(
      rows.reduce((sum, row) => sum + (row.attributedCents ?? 0n), 0n),
    ).toBe(5n);
    expect(rows.every((row) => row.sourceCents === 5n)).toBe(true);
    expect(rows.every((row) => row.basis === "positive")).toBe(true);

    const selected = [tax.id, unrelated.id, standalone.id];
    const global = await loadExpenseProjectAllocations(ctx.db);
    const scoped = await loadExpenseProjectAllocations(ctx.db, selected);
    expect(scoped).toEqual(
      expect.arrayContaining(
        global.filter((row) => selected.includes(row.expenseId)),
      ),
    );
    expect(scoped).toHaveLength(4);
    expect(await loadExpenseProjectAllocations(ctx.db, [])).toEqual([]);

    const correlated = await unwrapDb(ctx.db).execute<{
      names: string;
      cost: number;
      included: boolean;
    }>(sql`
      SELECT
        ${expenseProjectNamesSql(sql`outer_expense."id"`)} AS names,
        ${expenseAllocatedCostSql(sql`outer_expense."id"`, { projectIds: [smallProject.id] })} AS cost,
        ${expenseAllocationExistsSql(sql`outer_expense."id"`, { projectIds: [smallProject.id] })} AS included
      FROM "Expense" outer_expense
      WHERE outer_expense."id" = ${tax.id} AND outer_expense."deletedAt" IS NULL
    `);
    expect(correlated.rows).toEqual([
      {
        names: "Large allocation project, Small allocation project",
        cost: 0.02,
        included: true,
      },
    ]);

    const summary = await loadRelatedSummary(ctx.db, {
      relationKey: "purchase.projects",
      sourceId: purchase.shortcode,
      offset: 0,
      limit: 25,
    });
    expect(summary.totals).toMatchObject({
      itemSpend: 30,
      sharedChargeSpend: 0.05,
      netSpend: 30.05,
      incomplete: false,
    });
    expect(
      summary.data.map((row) => ({
        project: row.target?.label,
        itemSpend: row.itemSpend,
        sharedChargeSpend: row.sharedChargeSpend,
        netSpend: row.netSpend,
        incomplete: row.incomplete,
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          project: smallProject.name,
          itemSpend: 10,
          sharedChargeSpend: 0.02,
          netSpend: 10.02,
          incomplete: false,
        },
        {
          project: largeProject.name,
          itemSpend: 20,
          sharedChargeSpend: 0.03,
          netSpend: 20.03,
          incomplete: false,
        },
      ]),
    );
  });

  it("marks weighted charges incomplete when any principal price is unknown", async () => {
    const [pricedProject, unpricedProject] = await Promise.all([
      insertWithShortcode(ctx.db, "project", { name: "Priced project" }),
      insertWithShortcode(ctx.db, "project", { name: "Unpriced project" }),
    ]);
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Partial coverage vendor",
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-09-20",
    });
    await Promise.all([
      insertWithShortcode(ctx.db, "expense", {
        name: "Priced principal",
        cost: 10,
        date: "2026-09-20",
        lineKind: "principal",
        costType: "materials",
        trade: "other",
        future: false,
        projectId: pricedProject.id,
        purchaseId: purchase.id,
      }),
      insertWithShortcode(ctx.db, "expense", {
        name: "Unpriced principal",
        cost: null,
        date: "2026-09-20",
        lineKind: "principal",
        costType: "materials",
        trade: "other",
        future: false,
        projectId: unpricedProject.id,
        purchaseId: purchase.id,
      }),
    ]);
    const fee = await insertWithShortcode(ctx.db, "expense", {
      name: "Partially covered fee",
      cost: 1,
      date: "2026-09-20",
      lineKind: "fee",
      costType: "services",
      trade: null,
      future: false,
      purchaseId: purchase.id,
    });

    const rows = await loadExpenseProjectAllocations(ctx.db, [fee.id]);
    expect(rows).toEqual([
      expect.objectContaining({
        projectId: pricedProject.id,
        attributedCents: 100n,
        basis: "positive",
        incomplete: true,
      }),
    ]);

    const summary = await loadRelatedSummary(ctx.db, {
      relationKey: "purchase.projects",
      sourceId: purchase.shortcode,
      offset: 0,
      limit: 25,
    });
    expect(summary.totals).toMatchObject({
      itemSpend: 10,
      sharedChargeSpend: 1,
      netSpend: 11,
      incomplete: true,
    });
    expect(summary.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: expect.objectContaining({ id: pricedProject.shortcode }),
          sharedChargeSpend: 1,
          incomplete: true,
        }),
        expect.objectContaining({
          target: expect.objectContaining({ id: unpricedProject.shortcode }),
          itemSpend: 0,
          incomplete: true,
        }),
      ]),
    );
  });

  it("falls back to absolute refund weights when no positive principal exists", async () => {
    const projects = await Promise.all([
      insertWithShortcode(ctx.db, "project", { name: "Refund project one" }),
      insertWithShortcode(ctx.db, "project", { name: "Refund project two" }),
    ]);
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Refund allocation vendor",
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-09-20",
    });
    await Promise.all(
      [-10, -20].map((cost, index) =>
        insertWithShortcode(ctx.db, "expense", {
          name: `Refund principal ${index}`,
          cost,
          date: "2026-09-20",
          lineKind: "principal",
          costType: "materials",
          trade: "other",
          future: false,
          projectId: projects[index]!.id,
          purchaseId: purchase.id,
        }),
      ),
    );
    const discount = await insertWithShortcode(ctx.db, "expense", {
      name: "Refund adjustment",
      cost: -0.05,
      date: "2026-09-20",
      lineKind: "discount",
      costType: "materials",
      trade: "other",
      future: false,
      purchaseId: purchase.id,
    });

    const rows = await loadExpenseProjectAllocations(ctx.db, [discount.id]);
    expect(rows.map((row) => row.attributedCents).sort()).toEqual([-2n, -3n]);
    expect(
      rows.reduce((sum, row) => sum + (row.attributedCents ?? 0n), 0n),
    ).toBe(-5n);
    expect(rows.every((row) => row.basis === "refund")).toBe(true);
  });

  it("reports an incomplete Unassigned breakdown without principal weights", async () => {
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Incomplete allocation vendor",
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-09-20",
    });
    const fee = await insertWithShortcode(ctx.db, "expense", {
      name: "Unweighted shared fee",
      cost: 2.5,
      date: "2026-09-20",
      lineKind: "fee",
      costType: "services",
      trade: null,
      future: false,
      purchaseId: purchase.id,
    });

    expect(await loadExpenseProjectAllocations(ctx.db, [fee.id])).toEqual([
      expect.objectContaining({
        projectId: null,
        attributedCents: 250n,
        basis: "default",
        incomplete: true,
      }),
    ]);

    const summary = await loadRelatedSummary(ctx.db, {
      relationKey: "purchase.projects",
      sourceId: purchase.shortcode,
      offset: 0,
      limit: 25,
    });
    expect(summary.data).toEqual([
      expect.objectContaining({
        target: null,
        itemSpend: 0,
        sharedChargeSpend: 2.5,
        netSpend: 2.5,
        incomplete: true,
      }),
    ]);
  });

  it("floors weighted shares before assigning a tied leftover cent", async () => {
    const projects = await Promise.all([
      insertWithShortcode(ctx.db, "project", { name: "Sixty percent" }),
      insertWithShortcode(ctx.db, "project", { name: "Forty percent" }),
    ]);
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "One-cent allocation vendor",
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-09-20",
    });
    await Promise.all(
      [60, 40].map((cost, index) =>
        insertWithShortcode(ctx.db, "expense", {
          name: `Weighted principal ${cost}`,
          cost,
          date: "2026-09-20",
          lineKind: "principal",
          costType: "materials",
          trade: "other",
          future: false,
          projectId: projects[index]!.id,
          purchaseId: purchase.id,
        }),
      ),
    );
    const fee = await insertWithShortcode(ctx.db, "expense", {
      name: "One-cent fee",
      cost: 0.01,
      date: "2026-09-20",
      lineKind: "fee",
      costType: "services",
      trade: "other",
      future: false,
      purchaseId: purchase.id,
    });

    const rows = await loadExpenseProjectAllocations(ctx.db, [fee.id]);
    expect(rows.map((row) => row.attributedCents).sort()).toEqual([0n, 1n]);
    expect(
      rows.reduce((sum, row) => sum + (row.attributedCents ?? 0n), 0n),
    ).toBe(1n);
  });

  it("ORs a selected project with the unassigned presence sentinel", async () => {
    const project = await insertWithShortcode(ctx.db, "project", {
      name: "Selected allocation project",
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Mixed assignment vendor",
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-09-20",
    });
    await Promise.all(
      [project.id, null].map((projectId, index) =>
        insertWithShortcode(ctx.db, "expense", {
          name: `Mixed principal ${index}`,
          cost: 50,
          date: "2026-09-20",
          lineKind: "principal",
          costType: "materials",
          trade: "other",
          future: false,
          projectId,
          purchaseId: purchase.id,
        }),
      ),
    );
    const fee = await insertWithShortcode(ctx.db, "expense", {
      name: "Mixed assignment fee",
      cost: 0.03,
      date: "2026-09-20",
      lineKind: "fee",
      costType: "services",
      trade: null,
      future: false,
      purchaseId: purchase.id,
    });
    const scope = { projectIds: [project.id], presence: "none" as const };
    const result = await unwrapDb(ctx.db).execute<{
      included: boolean;
      attributedCost: number;
    }>(sql`SELECT
      ${expenseAllocationExistsSql(sql`${fee.id}::uuid`, scope)} AS included,
      ${expenseAllocatedCostSql(sql`${fee.id}::uuid`, scope)} AS "attributedCost"`);

    expect(result.rows[0]).toEqual({ included: true, attributedCost: 0.03 });
  });
});
