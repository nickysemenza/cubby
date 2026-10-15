import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { expect, it } from "vitest";

import { unwrapDb } from "./database-helpers";
import {
  expenseDerivedReadSql,
  prepareExpenseDerivedRead,
} from "./expense-derived-read";
import { insertWithShortcode } from "./shortcode-utils";

const ctx = withTestDb("mcp");

// Broad relational scopes must not turn into poorly estimated opaque arrays.
it("keeps broad prepared scopes set-based and sparse scopes on full sibling weights", async () => {
  const vendor = await insertWithShortcode(ctx.db, "vendor", {
    name: "Synthetic scope vendor",
  });
  let firstPurchase;
  for (let index = 0; index < 800; index++) {
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-09-20",
    });
    firstPurchase ??= purchase;
    for (const lineKind of ["principal", "principal", "tax"] as const) {
      await insertWithShortcode(ctx.db, "expense", {
        name: "Synthetic scope line",
        purchaseId: purchase.id,
        date: "2026-09-20",
        cost: lineKind === "tax" ? 0.01 : 1,
        lineKind,
        costType: "materials",
        trade: "other",
        future: false,
      });
    }
  }
  await unwrapDb(ctx.db).execute(sql`ANALYZE "Expense"`);
  type Node = {
    "Node Type": string;
    "Subplan Name"?: string;
    "Relation Name"?: string;
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
  const visit = (node: Node) => {
    if (node["Node Type"] === "CTE Scan")
      cteRowsVisited += node["Actual Rows"] * node["Actual Loops"];
    for (const child of node.Plans ?? []) visit(child);
  };
  const plan = result.rows[0]!["QUERY PLAN"][0]!.Plan;
  visit(plan);
  expect(plan["Actual Rows"]).toBe(3200);
  expect(cteRowsVisited).toBeLessThan(2400 * 20);
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
}, 60000);
