import type { ExpenseId } from "@cubby/schemas/identifiers";
import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { expect, it } from "vitest";

import { unwrapDb } from "~/server/db/helpers";
import { expense } from "~/server/db/schema";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import {
  expenseDerivedReadSql,
  prepareExpenseDerivedRead,
  executeExpenseDerivedBatches,
  executeExpenseDerivedBatch,
  expenseDerivedBatchesSql,
  type ExpenseDerivedBatchRead,
} from "./expense-derived-read";

const ctx = withTestDb();

// Broad relational scopes must not turn into poorly estimated opaque arrays.
it("keeps broad prepared scopes set-based and sparse scopes on full sibling weights", async () => {
  const vendor = await insertWithShortcode(ctx.db, "vendor", {
    name: "Synthetic scope vendor",
  });
  const project = await insertWithShortcode(ctx.db, "project", {
    name: "Synthetic scope project",
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
        trade: "other",
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
