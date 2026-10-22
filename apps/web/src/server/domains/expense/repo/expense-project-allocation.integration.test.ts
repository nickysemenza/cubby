import { expenseLineKindSchema } from "@cubby/schemas/expense-line-kind";
import type {
  ProductCategoryId,
  ProjectId,
  PurchaseId,
} from "@cubby/schemas/identifiers";
import { productCategoryFeature } from "@cubby/schemas/product-category-fields";
import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { unwrapDb } from "~/server/db/helpers";
import { expense, project } from "~/server/db/schema";
import {
  expenseDerivedReadSql,
  expenseDerivedMembershipSql,
  expenseDerivedValueSql,
  prepareExpenseDerivedRead,
} from "~/server/domains/expense/repo/expense-derived-read";
import { loadRelatedSummary } from "~/server/generic/entity-links/repo/related-view";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { insertEntityFixtures } from "~/server/testing/repo.fixtures";

import { expenseDerivedCostsSql } from "./expense-derived-read";
import {
  effectiveExpenseProjectSql,
  effectiveExpenseTradeSql,
  principalExpenseInheritanceSql,
} from "./expense-inheritance";
import {
  expenseJointAllocationSql,
  loadExpenseProjectAllocations,
} from "./expense-project-allocation";
import { buildExpenseWhereClause } from "./lookup";

const allocationPlanNode = z.object({
  "Subplan Name": z.string().optional(),
  "Actual Loops": z.number().optional(),
  "Node Type": z.string(),
  get Plans() {
    return z.array(allocationPlanNode).optional();
  },
});
const allocationPlan = z.array(z.object({ Plan: allocationPlanNode }));

describe("expense project allocation", () => {
  const ctx = withTestDb("mcp");

  // Missing project references must skip Project reads, including a Purchase
  // whose defaultProjectId is null. Small household tables otherwise get
  // scanned once per Expense by correlated scalar lookup plans.
  it("skips project lookups for absent explicit and purchase defaults", async () => {
    for (let index = 0; index < 8; index++)
      await insertWithShortcode(ctx.db, "project", {
        name: `Synthetic unrelated project ${index}`,
      });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic no-project supplier",
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
    });
    for (let index = 0; index < 16; index++)
      await insertWithShortcode(ctx.db, "expense", {
        name: `Synthetic unassigned line ${index}`,
        costType: "materials",
        lineKind: "principal",
        purchaseId: index % 2 === 0 ? purchase.id : null,
      });
    await unwrapDb(ctx.db).execute(
      sql`ANALYZE "Project", "Purchase", "Expense"`,
    );
    const statement = sql`SELECT ${effectiveExpenseProjectSql()} AS "projectId" FROM "Expense"`;
    expect((await unwrapDb(ctx.db).execute(statement)).rows).toEqual(
      Array.from({ length: 16 }, () => ({ projectId: null })),
    );
    const result = await unwrapDb(ctx.db).execute(
      sql`EXPLAIN (ANALYZE, FORMAT JSON) ${statement}`,
    );
    const nodeSchema = z.object({
      "Relation Name": z.string().optional(),
      "Actual Loops": z.number().default(0),
      get Plans() {
        return z.array(nodeSchema).optional();
      },
    });
    const plans = z
      .array(
        z.object({ "QUERY PLAN": z.array(z.object({ Plan: nodeSchema })) }),
      )
      .parse(result.rows);
    let projectLookups = 0;
    const visit = (node: z.infer<typeof nodeSchema>) => {
      if (node["Relation Name"] === "Project")
        projectLookups += node["Actual Loops"];
      node.Plans?.forEach(visit);
    };
    for (const row of plans)
      row["QUERY PLAN"].forEach(({ Plan }) => visit(Plan));
    expect(projectLookups).toBe(0);
  });

  it("keeps unclassified money once and marks sibling allocation denominators incomplete", async () => {
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Unclassified allocation fixture vendor",
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-09-20",
    });
    await insertWithShortcode(ctx.db, "expense", {
      name: "Known receipt item",
      cost: 10,
      date: "2026-09-20",
      lineKind: "principal",
      costType: "materials",
      trade: "other",
      future: false,
      purchaseId: purchase.id,
    });
    const unresolved = await insertWithShortcode(ctx.db, "expense", {
      name: "Unresolved receipt row",
      cost: -1.25,
      date: "2026-09-20",
      lineKind: "unclassified",
      costType: "services",
      trade: null,
      future: false,
      purchaseId: purchase.id,
    });
    const tax = await insertWithShortcode(ctx.db, "expense", {
      name: "Known receipt tax",
      cost: 0.25,
      date: "2026-09-20",
      lineKind: "tax",
      costType: "services",
      trade: null,
      future: false,
      purchaseId: purchase.id,
    });

    expect(
      await loadExpenseProjectAllocations(ctx.db, [unresolved.id]),
    ).toEqual([
      expect.objectContaining({
        purchaseId: purchase.id,
        projectId: null,
        sourceCents: -125n,
        attributedCents: -125n,
        basis: "unclassified",
        incomplete: true,
      }),
    ]);
    const siblingRows = await loadExpenseProjectAllocations(ctx.db, [tax.id]);
    expect(siblingRows).toEqual([
      expect.objectContaining({
        sourceCents: 25n,
        attributedCents: 25n,
        incomplete: true,
      }),
    ]);
  });

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
      sql`EXPLAIN (ANALYZE, COSTS OFF) ${expenseDerivedReadSql("projects", { expenseIds: [tax.id] })}`,
    );
    const planText = plan.rows.map((row) => row["QUERY PLAN"]).join("\n");
    expect(
      planText.match(/CTE principal_fact\n[^\n]*rows=(\d+) loops=1/u)?.[1],
    ).toBe("3");
    // Project rollups never read the category, and resolving it per principal
    // line made the whole-ledger project read ~10x slower.
    expect(planText).not.toMatch(/CTE (ancestors|mapping|facts)\b/u);

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

    // Stored row filters must select complete purchases before allocation:
    // these principals fail the tax/cost filters but still supply its weights.
    const filteredWhere = await buildExpenseWhereClause(ctx.db, {
      lineKind: "tax",
      costMin: 0.01,
      costMax: 0.1,
      projectId: smallProject.shortcode,
    });
    expect(
      await unwrapDb(ctx.db)
        .select({ id: expense.id })
        .from(expense)
        .where(filteredWhere),
    ).toEqual([{ id: tax.id }]);

    // Filtering the output to one adjustment must retain both principals in
    // its denominator, and each selected line must produce just one total.
    const totals = await unwrapDb(ctx.db).execute<{
      expenseId: string;
      cost: number;
    }>(
      expenseDerivedCostsSql(
        { projectIds: [smallProject.id] },
        sql`ARRAY[${tax.id}]::uuid[]`,
      ),
    );
    expect(totals.rows).toMatchObject([{ expenseId: tax.id, cost: 0.02 }]);
    const ledgerTotal = await unwrapDb(ctx.db).execute<{
      expenseId: string;
      cost: number;
    }>(expenseDerivedCostsSql(undefined, sql`ARRAY[${standalone.id}]::uuid[]`));
    expect(ledgerTotal.rows).toMatchObject([
      { expenseId: standalone.id, cost: -5 },
    ]);

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
        ${expenseDerivedValueSql("projectNames", sql`outer_expense."id"`)} AS names,
        ${expenseDerivedValueSql("cost", sql`outer_expense."id"`, { projectIds: [smallProject.id] })} AS cost,
        ${expenseDerivedMembershipSql(sql`outer_expense."id"`, { projectIds: [smallProject.id] })} AS included
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

    // A grouped read must allocate once for the whole selected ledger. A
    // correlated allocation under sum() repeats all sibling weighting for
    // every output row, even when its share scope is identical.
    const groupedPlan = await unwrapDb(ctx.db).execute<{
      "QUERY PLAN": z.infer<typeof allocationPlan>;
    }>(sql`EXPLAIN (ANALYZE, FORMAT JSON, COSTS OFF)
      SELECT sum(${expenseDerivedValueSql("cost", sql`outer_expense."id"`, { projectIds: [smallProject.id] })})
      FROM "Expense" outer_expense WHERE outer_expense."deletedAt" IS NULL`);
    const allocationLoops: number[] = [];
    const correlatedAllocations: number[] = [];
    const inspectPlan = (node: z.infer<typeof allocationPlanNode>) => {
      if (node["Subplan Name"] === "CTE principal_fact")
        allocationLoops.push(Number(node["Actual Loops"]));
      if (
        String(node["Subplan Name"]).startsWith("SubPlan") &&
        node["Node Type"] === "Aggregate"
      )
        correlatedAllocations.push(Number(node["Actual Loops"]));
      for (const child of node.Plans ?? []) inspectPlan(child);
    };
    inspectPlan(
      allocationPlan.parse(groupedPlan.rows[0]!["QUERY PLAN"])[0]!.Plan,
    );
    expect(allocationLoops).toEqual([1]);
    expect(correlatedAllocations).toEqual([]);

    // The embedded project scope selects whole expenses, while a direct
    // project filter measures its shares. Different shares may satisfy each
    // predicate; intersecting projects would lose this shared charge.
    // The scope is part of the where, through the bounded allocation-share
    // row set, so the read allocates once per place the where appears, and
    // each allocation still runs once, uncorrelated.
    const embeddedRead = await prepareExpenseDerivedRead(ctx.db, {
      projectId: smallProject.shortcode,
      projectScope: { search: largeProject.name },
      lineKind: "tax",
    });
    const embeddedQuery = embeddedRead
      .select({ cost: embeddedRead.cost })
      .where(embeddedRead.where);
    expect(await embeddedQuery).toEqual([{ cost: 0.02 }]);
    const embeddedPlan = await unwrapDb(ctx.db).execute<{
      "QUERY PLAN": z.infer<typeof allocationPlan>;
    }>(sql`EXPLAIN (ANALYZE, FORMAT JSON, COSTS OFF) ${embeddedQuery}`);
    allocationLoops.length = 0;
    correlatedAllocations.length = 0;
    inspectPlan(
      allocationPlan.parse(embeddedPlan.rows[0]!["QUERY PLAN"])[0]!.Plan,
    );
    expect(allocationLoops).not.toEqual([]);
    expect(allocationLoops.every((loops) => loops === 1)).toBe(true);
    expect(correlatedAllocations).toEqual([]);

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

    // Unknown prices still establish membership and remain unknown in the
    // grouped cost projection rather than disappearing or becoming zero.
    const unknownCosts = await unwrapDb(ctx.db).execute<{
      cost: number | null;
    }>(expenseDerivedCostsSql({ projectIds: [unpricedProject.id] }));
    expect(unknownCosts.rows).toMatchObject([{ cost: null }]);

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

  // The allocation resolves principal projects and trades through joins; they
  // must match the scalar resolvers line for line, including deleted
  // overrides, deleted Purchases and the household food fallback.
  it("joins the same project and trade inheritance as the scalar resolvers", async () => {
    const [explicit, fallback, gone, tradeProject] = await Promise.all([
      insertWithShortcode(ctx.db, "project", { name: "Synthetic explicit" }),
      insertWithShortcode(ctx.db, "project", { name: "Synthetic default" }),
      insertWithShortcode(ctx.db, "project", { name: "Synthetic removed" }),
      insertWithShortcode(ctx.db, "project", {
        name: "Synthetic trade default",
        defaultTrade: "electrical",
      }),
    ]);
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "Project" SET "deletedAt" = now() WHERE id = ${gone.id}`,
    );
    // The food fallback resolves the household Project by its fixed code.
    const [household] = await insertEntityFixtures(ctx.db, project, "project", [
      { shortcode: "PRJ-HSHD", name: "Synthetic household" },
    ]);
    const food = await unwrapDb(ctx.db).execute<{ id: ProductCategoryId }>(
      sql`SELECT id FROM "ProductCategory" WHERE feature = ${productCategoryFeature.enum.food} AND "deletedAt" IS NULL LIMIT 1`,
    );
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic inheritance supplier",
    });
    const [withDefault, removedDefault, deleted] = await Promise.all([
      insertWithShortcode(ctx.db, "purchase", {
        vendorId: vendor.id,
        defaultProjectId: fallback.id,
        defaultTrade: "plumbing",
      }),
      insertWithShortcode(ctx.db, "purchase", {
        vendorId: vendor.id,
        defaultProjectId: gone.id,
      }),
      insertWithShortcode(ctx.db, "purchase", {
        vendorId: vendor.id,
        defaultProjectId: fallback.id,
        defaultTrade: "plumbing",
      }),
    ]);
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "Purchase" SET "deletedAt" = now() WHERE id = ${deleted.id}`,
    );
    const [foodCategory] = food.rows;
    expect(foodCategory).toBeDefined();
    const groceries = await insertWithShortcode(ctx.db, "product", {
      name: "Synthetic oats",
      manufacturer: "Synthetic mill",
      categoryId: foodCategory!.id,
    });
    const principal = (extra: Partial<typeof expense.$inferInsert>) =>
      insertWithShortcode(ctx.db, "expense", {
        name: "Synthetic inherited line",
        cost: 1,
        date: "2026-09-20",
        lineKind: "principal",
        costType: "materials",
        future: false,
        ...extra,
      });
    await principal({ projectId: explicit.id, purchaseId: withDefault.id });
    await principal({ projectId: gone.id, purchaseId: withDefault.id });
    await principal({ purchaseId: withDefault.id, trade: "drywall" });
    await principal({ purchaseId: removedDefault.id });
    await principal({ purchaseId: deleted.id });
    await principal({ projectId: tradeProject.id });
    await principal({
      productId: groceries.id,
      purchaseId: removedDefault.id,
    });
    await principal({ productId: groceries.id, projectId: explicit.id });

    const inherited = principalExpenseInheritanceSql("e", "live_purchase");
    const lines = await unwrapDb(ctx.db).execute<{
      scalarProject: string | null;
      joinedProject: string | null;
      scalarTrade: string | null;
      joinedTrade: string | null;
    }>(sql`SELECT
        ${effectiveExpenseProjectSql("e")} AS "scalarProject", ${inherited.projectId} AS "joinedProject",
        ${effectiveExpenseTradeSql("e")} AS "scalarTrade", ${inherited.trade} AS "joinedTrade"
      FROM "Expense" e
      LEFT JOIN "Purchase" live_purchase
        ON live_purchase.id = e."purchaseId" AND live_purchase."deletedAt" IS NULL
      ${inherited.joins}
      WHERE e."deletedAt" IS NULL AND e."lineKind" = ${expenseLineKindSchema.enum.principal}`);
    expect(lines.rows).toHaveLength(8);
    for (const line of lines.rows) {
      expect(line.joinedProject).toBe(line.scalarProject);
      expect(line.joinedTrade).toBe(line.scalarTrade);
    }
    const projects = new Set(lines.rows.map((line) => line.scalarProject));
    expect(projects).toEqual(
      new Set([explicit.id, fallback.id, null, tradeProject.id, household!.id]),
    );
    expect(new Set(lines.rows.map((line) => line.scalarTrade))).toEqual(
      new Set(["plumbing", "drywall", null, "electrical"]),
    );
  });

  // Grouped reads weigh a purchase whose principals share every dimension as
  // one line. Largest remainder must still hand that group exactly what the
  // per-principal split sums to, for every grouped read and purchase shape.
  it("matches the per-principal split for every grouped read", async () => {
    const [first, second] = await Promise.all([
      insertWithShortcode(ctx.db, "project", { name: "Synthetic first" }),
      insertWithShortcode(ctx.db, "project", { name: "Synthetic second" }),
    ]);
    const [pantry, hardware] = await Promise.all([
      insertWithShortcode(ctx.db, "spendingCategory", {
        name: `Synthetic pantry ${crypto.randomUUID()}`,
      }),
      insertWithShortcode(ctx.db, "spendingCategory", {
        name: `Synthetic hardware ${crypto.randomUUID()}`,
      }),
    ]);
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic split supplier",
    });
    const order = (defaultProjectId?: ProjectId) =>
      insertWithShortcode(ctx.db, "purchase", {
        vendorId: vendor.id,
        date: "2026-09-20",
        defaultProjectId,
      });
    const line = (
      purchaseId: PurchaseId,
      lineKind: "principal" | "tax" | "fee" | "shipping" | "discount",
      cost: number | null,
      extra: Partial<typeof expense.$inferInsert> = {},
    ) =>
      insertWithShortcode(ctx.db, "expense", {
        name: `Synthetic ${lineKind} ${cost}`,
        cost,
        date: "2026-09-20",
        lineKind,
        costType: lineKind === "principal" ? "materials" : "services",
        future: false,
        purchaseId,
        ...extra,
      });
    const uniform = await order();
    for (let index = 0; index < 3; index++)
      await line(uniform.id, "principal", 1, { projectId: first.id });
    await line(uniform.id, "tax", 1);
    await line(uniform.id, "fee", 0.02, { trade: "plumbing" });
    const mixed = await order();
    await line(mixed.id, "principal", 1, { projectId: first.id });
    await line(mixed.id, "principal", 2, { projectId: second.id });
    await line(mixed.id, "principal", 0, { projectId: second.id });
    await line(mixed.id, "shipping", 0.1);
    await line(mixed.id, "discount", -0.07);
    const zeros = await order();
    for (let index = 0; index < 2; index++)
      await line(zeros.id, "principal", 0, { projectId: second.id });
    await line(zeros.id, "fee", 0.05);
    const costTypes = await order();
    await line(costTypes.id, "principal", 3, { projectId: first.id });
    await line(costTypes.id, "principal", 3, {
      projectId: first.id,
      costType: "tools",
    });
    await line(costTypes.id, "tax", 0.01);
    const categories = await order();
    await line(categories.id, "principal", 1, {
      projectId: first.id,
      spendingCategoryId: pantry.id,
    });
    await line(categories.id, "principal", 1, {
      projectId: first.id,
      spendingCategoryId: hardware.id,
    });
    await line(categories.id, "tax", 0.03);
    const unpriced = await order();
    await line(unpriced.id, "principal", 5, { projectId: first.id });
    await line(unpriced.id, "principal", null, { projectId: first.id });
    await line(unpriced.id, "tax", 0.02);
    const fallback = await order(second.id);
    await line(fallback.id, "tax", 0.04);
    const trades = await order();
    await line(trades.id, "principal", 2, {
      projectId: first.id,
      trade: "plumbing",
    });
    await line(trades.id, "principal", 2, {
      projectId: first.id,
      trade: "electrical",
    });
    await line(trades.id, "tax", 0.03);
    // A negative non-discount adjustment against positive principals keeps
    // no category.
    await line(trades.id, "fee", -0.05);
    const refund = await order();
    await line(refund.id, "principal", -1, { projectId: second.id });
    await line(refund.id, "principal", -2, { projectId: second.id });
    await line(refund.id, "tax", -0.03);

    const rows = async (statement: ReturnType<typeof sql>) =>
      (await unwrapDb(ctx.db).execute(statement)).rows
        .map((row) => JSON.stringify(row))
        .sort();
    const allDimensions = { categories: true, trades: true, projects: true };
    const projectsOnly = { categories: false, trades: false, projects: true };
    const reads = [
      ["projects", projectsOnly, undefined],
      ["names", projectsOnly, undefined],
      ["presence", projectsOnly, undefined],
      ["costs", projectsOnly, { projectIds: [first.id] }],
      ["categories", allDimensions, undefined],
      ["categoryNames", allDimensions, undefined],
      ["categoryEvidence", allDimensions, undefined],
      [
        "costs",
        { categories: false, trades: true, projects: true },
        { trades: ["plumbing"] as const },
      ],
      ["presence", projectsOnly, { presence: "none" as const }],
      ["costs", projectsOnly, { presence: "has" as const }],
      ["categories", allDimensions, { spendingCategoryIds: [pantry.id] }],
      [
        "names",
        { categories: true, trades: true, projects: true },
        { categoryPresence: "has" as const, costTypes: ["materials"] as const },
      ],
    ] as const;
    // Selections allocate complete purchases, then keep the selected lines.
    const selections = [
      undefined,
      {
        select: sql`SELECT id FROM "Expense"
          WHERE "purchaseId" IN (${uniform.id}, ${mixed.id}, ${trades.id}) AND "deletedAt" IS NULL`,
      },
    ];
    for (const expenseIds of selections)
      for (const [read, dimensions, scope] of reads) {
        const perPrincipal = expenseJointAllocationSql(expenseIds, undefined, {
          ...dimensions,
          principals: true,
        });
        expect(
          await rows(expenseDerivedReadSql(read, { scope, expenseIds })),
        ).toEqual(
          await rows(
            expenseDerivedReadSql(read, {
              scope,
              expenseIds,
              source: perPrincipal,
            }),
          ),
        );
      }
    const members = (source?: ReturnType<typeof sql>) =>
      rows(
        sql`SELECT DISTINCT "expenseId" FROM (${expenseDerivedReadSql(
          "membership",
          { scope: { projectIds: [first.id] }, source },
        )}) member`,
      );
    expect(await members()).toEqual(
      await members(
        expenseJointAllocationSql(undefined, undefined, {
          categories: false,
          trades: false,
          projects: true,
          principals: true,
        }),
      ),
    );

    // The uniform tax still splits by principal where a read exposes it.
    const tax = await unwrapDb(ctx.db).execute<{ attributedCents: string }>(
      sql`SELECT share."attributedCents" FROM (${expenseDerivedReadSql("shares")}) share
        JOIN "Expense" e ON e.id = share."expenseId"
        WHERE e."purchaseId" = ${uniform.id} AND e."lineKind" = ${expenseLineKindSchema.enum.tax}
        ORDER BY share."attributedCents"::bigint`,
    );
    expect(tax.rows.map((row) => row.attributedCents)).toEqual([
      "33",
      "33",
      "34",
    ]);
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
      ${expenseDerivedMembershipSql(sql`${fee.id}::uuid`, scope)} AS included,
      ${expenseDerivedValueSql("cost", sql`${fee.id}::uuid`, scope)} AS "attributedCost"`);

    expect(result.rows[0]).toEqual({ included: true, attributedCost: 0.03 });
  });
});
