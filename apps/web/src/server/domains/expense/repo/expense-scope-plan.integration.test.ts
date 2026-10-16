import type { ExpenseId } from "@cubby/schemas/identifiers";
import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { expect, it } from "vitest";

import { unwrapDb } from "~/server/db/helpers";
import { expense } from "~/server/db/schema";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import {
  expenseDerivedReadSql,
  expenseDerivedMembershipSql,
  prepareExpenseDerivedRead,
  executeExpenseDerivedBatches,
  executeExpenseDerivedBatch,
  expenseDerivedBatchesSql,
  type ExpenseDerivedBatchRead,
} from "./expense-derived-read";

const ctx = withTestDb();

// Membership means a matching share exists, even when cent rounding gives
// that Project zero cents. Amount filters must not replace this contract.
it("keeps zero-cent Project shares in Expense membership", async () => {
  const small = await insertWithShortcode(ctx.db, "project", {
    name: "Synthetic small-share project",
  });
  const large = await insertWithShortcode(ctx.db, "project", {
    name: "Synthetic large-share project",
  });
  const vendor = await insertWithShortcode(ctx.db, "vendor", {
    name: "Synthetic cent-share vendor",
  });
  const order = await insertWithShortcode(ctx.db, "purchase", {
    vendorId: vendor.id,
    date: "2026-09-20",
  });
  for (const [projectId, cost] of [
    [small.id, 1],
    [large.id, 2],
  ] as const) {
    await insertWithShortcode(ctx.db, "expense", {
      name: "Synthetic cent-share principal",
      purchaseId: order.id,
      projectId,
      date: "2026-09-20",
      cost,
      lineKind: "principal",
      costType: "materials",
      trade: "other",
      future: false,
    });
  }
  const tax = await insertWithShortcode(ctx.db, "expense", {
    name: "Synthetic cent-share tax",
    purchaseId: order.id,
    date: "2026-09-20",
    cost: 0.01,
    lineKind: "tax",
    costType: "services",
    trade: null,
    future: false,
  });
  const scope = { projectIds: [small.id] };
  const cents = await unwrapDb(ctx.db).execute<{ cost: number }>(
    expenseDerivedReadSql("costs", { scope, expenseIds: [tax.id] }),
  );
  expect(cents.rows).toMatchObject([{ cost: 0 }]);
  for (const membershipScope of [scope, { trades: ["other"] as const }]) {
    expect(
      await unwrapDb(ctx.db)
        .select({ id: expense.id })
        .from(expense)
        .where(
          sql`${expense.id} = ${tax.id} AND ${expenseDerivedMembershipSql(sql`${expense.id}`, membershipScope, [tax.id])}`,
        ),
    ).toEqual([{ id: tax.id }]);
  }
});

// Broad relational scopes must not turn into poorly estimated opaque arrays.
it("keeps broad prepared scopes set-based and sparse scopes on full sibling weights", async () => {
  const vendor = await insertWithShortcode(ctx.db, "vendor", {
    name: "Synthetic scope vendor",
  });
  const project = await insertWithShortcode(ctx.db, "project", {
    name: "Synthetic scope project",
    defaultTrade: "other",
  });
  let firstPurchase;
  let firstTax: ExpenseId | undefined;
  for (let index = 0; index < 200; index++) {
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      defaultProjectId: project.id,
      date: "2026-09-20",
    });
    firstPurchase ??= purchase;
    for (const lineKind of ["principal", "principal", "tax"] as const) {
      const line = await insertWithShortcode(ctx.db, "expense", {
        name: "Synthetic scope line",
        purchaseId: purchase.id,
        date: "2026-09-20",
        cost: lineKind === "tax" ? 0.01 : 1,
        lineKind,
        costType: "materials",
        trade: null,
        future: false,
      });
      if (lineKind === "tax") firstTax ??= line.id;
    }
  }
  await unwrapDb(ctx.db).execute(sql`ANALYZE "Expense", "Purchase"`);
  type Node = {
    "Node Type": string;
    "Subplan Name"?: string;
    "Plan Rows": number;
    "Actual Rows": number;
    "Actual Loops": number;
    Plans?: Node[];
  };
  const prepared = await prepareExpenseDerivedRead(ctx.db, {});
  const result = await unwrapDb(ctx.db).execute<{
    "QUERY PLAN": { Plan: Node }[];
  }>(
    sql`EXPLAIN (ANALYZE, FORMAT JSON) ${expenseDerivedReadSql("shares", { expenseIds: prepared.expenseIds })}`,
  );
  let cteRowsVisited = 0;
  const selected: Node[] = [];
  const visit = (node: Node) => {
    if (node["Subplan Name"] === "CTE selected_expense") selected.push(node);
    if (node["Node Type"] === "CTE Scan")
      cteRowsVisited += node["Actual Rows"] * node["Actual Loops"];
    for (const child of node.Plans ?? []) visit(child);
  };
  const plan = result.rows[0]!["QUERY PLAN"][0]!.Plan;
  visit(plan);
  expect(plan["Actual Rows"]).toBe(800);
  expect(cteRowsVisited).toBeLessThan(600 * 20);
  expect(selected.length).toBeGreaterThan(0);
  for (const node of selected)
    expect(node["Plan Rows"]).toBeGreaterThan(node["Actual Rows"] / 4);
  // The sparse case reaches allocation through a prepared relational scope.
  const sparse = await prepareExpenseDerivedRead(ctx.db, {
    purchaseId: firstPurchase!.shortcode,
    lineKind: "tax",
  });
  const shares = await unwrapDb(ctx.db).execute<{ attributedCents: string }>(
    expenseDerivedReadSql("shares", { expenseIds: sparse.expenseIds }),
  );
  expect(shares.rows.map((row) => row.attributedCents).sort()).toEqual([
    "0",
    "1",
  ]);
  // Trade and cost-type projections must retain rounded adjustment shares
  // and Project-inherited trade independently of the projected dimensions.
  for (const scope of [
    { trades: ["other"] as const },
    { costTypes: ["materials"] as const },
    { trades: ["other"] as const, categoryPresence: "none" as const },
    { costTypes: ["materials"] as const, projectIds: [project.id] },
    { trades: ["other"] as const, membershipProjectIds: [project.id] },
    { presence: "has" as const },
  ]) {
    const costs = await unwrapDb(ctx.db).execute<{
      expenseId: string;
      cost: number;
    }>(
      expenseDerivedReadSql("costs", { scope, expenseIds: sparse.expenseIds }),
    );
    expect(costs.rows).toMatchObject([{ expenseId: firstTax!, cost: 0.01 }]);
    // Membership consumes IDs, but its trade and Project constraints still
    // follow complete, rounded shares and must return each Expense once.
    expect(
      await unwrapDb(ctx.db)
        .select({ id: expense.id })
        .from(expense)
        .where(
          sql`${expense.id} = ${firstTax!} AND ${expenseDerivedMembershipSql(sql`${expense.id}`, scope, sparse.expenseIds)}`,
        ),
    ).toEqual([{ id: firstTax! }]);
  }
  expect(
    await unwrapDb(ctx.db)
      .select({ id: expense.id })
      .from(expense)
      .where(
        sql`${expense.id} = ${firstTax!} AND ${expenseDerivedMembershipSql(sql`${expense.id}`, { presence: "none" }, sparse.expenseIds)}`,
      ),
  ).toEqual([]);
  const scope = { projectIds: [project.id] };
  const contexts = {
    broad: { ...prepared, scope },
    single: {
      ...prepared,
      scope,
      expenseIds: [firstTax!],
      where: eq(expense.id, firstTax!),
    },
  };
  const projection = (read: ExpenseDerivedBatchRead) =>
    read
      .select({
        cents: sql<number>`coalesce(round(sum(${read.cost}::numeric) * 100), 0)::int`,
      })
      .where(read.where);
  const projections = (
    reads: Readonly<Record<string, ExpenseDerivedBatchRead>>,
  ) => ({
    broad: projection(reads.broad!),
    single: projection(reads.single!),
  });
  const batch = await unwrapDb(ctx.db).execute<{
    "QUERY PLAN": { Plan: Node }[];
  }>(
    sql`EXPLAIN (ANALYZE, FORMAT JSON) ${expenseDerivedBatchesSql(ctx.db, contexts, projections)}`,
  );
  selected.length = 0;
  cteRowsVisited = 0;
  visit(batch.rows[0]!["QUERY PLAN"][0]!.Plan);
  expect(selected.length).toBeGreaterThan(0);
  for (const node of selected)
    expect(node["Plan Rows"]).toBeGreaterThan(node["Actual Rows"] / 4);
  expect(cteRowsVisited).toBeLessThan(600 * 40);
  const combined = await executeExpenseDerivedBatches(
    ctx.db,
    contexts,
    projections,
  );
  expect(combined).toEqual({
    broad: [{ cents: 40200 }],
    single: [{ cents: 1 }],
  });
  const single = await executeExpenseDerivedBatch(
    ctx.db,
    contexts.single,
    (read) => ({ single: projection(read) }),
  );
  expect(combined.single).toEqual(single.single);
});
