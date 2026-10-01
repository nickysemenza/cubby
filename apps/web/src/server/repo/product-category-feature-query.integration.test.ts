import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/repo/database-helpers";

import {
  categoryFeatureInSql,
  categoryFeatureSql,
  categorySummarySql,
} from "./product-category-sql";

const ctx = withTestDb();

// Repeated ancestry scans hold origin connections long enough to starve other
// requests. Browser journeys cannot distinguish that from an ordinary slow read.
describe("batched category feature lookup", () => {
  it("resolves the category set once across a page of candidates", async () => {
    const result = await getDb(ctx.db).execute<{
      "QUERY PLAN": { Plan: PlanNode }[];
    }>(sql`EXPLAIN (ANALYZE, FORMAT JSON)
      SELECT ${categoryFeatureSql(sql`candidate."id"`, "food")}
      FROM "ProductCategory" candidate
      CROSS JOIN generate_series(1, 8) copies
      WHERE candidate."deletedAt" IS NULL`);
    type PlanNode = {
      "Node Type": string;
      "Actual Loops": number;
      Plans?: PlanNode[];
    };
    const recursiveLoops: number[] = [];
    function visit(node: PlanNode) {
      if (node["Node Type"] === "Recursive Union") {
        recursiveLoops.push(node["Actual Loops"]);
      }
      for (const child of node.Plans ?? []) visit(child);
    }
    const plan = result.rows[0]?.["QUERY PLAN"][0]?.Plan;
    if (!plan) throw new Error("PostgreSQL returned no execution plan");
    visit(plan);
    expect(recursiveLoops.length).toBeGreaterThan(0);
    expect(Math.max(...recursiveLoops)).toBe(1);
  });

  it("preserves nearest live features through inheritance, overrides, depth limits and cycles", async () => {
    // Shadow only this transaction's table to exercise malformed legacy trees
    // without weakening the permanent taxonomy constraints.
    await getDb(ctx.db).transaction(async (tx) => {
      await tx.execute(sql`CREATE TEMP TABLE "ProductCategory" (
        "id" uuid PRIMARY KEY, "parentId" uuid, "shortcode" text, "name" text,
        "feature" text, "deletedAt" timestamptz
      ) ON COMMIT DROP`);
      const nodes = [
        { parent: null, feature: "food", deleted: false },
        { parent: 0, feature: null, deleted: false },
        { parent: 1, feature: null, deleted: false },
        { parent: 2, feature: null, deleted: false },
        { parent: 0, feature: "tools", deleted: false },
        { parent: 4, feature: null, deleted: false },
        { parent: 4, feature: "food", deleted: false },
        { parent: 6, feature: null, deleted: false },
        { parent: 0, feature: null, deleted: true },
        { parent: 8, feature: null, deleted: false },
        { parent: null, feature: "food", deleted: true },
        { parent: 10, feature: null, deleted: false },
        { parent: 13, feature: "food", deleted: false },
        { parent: 12, feature: null, deleted: false },
        { parent: 15, feature: null, deleted: false },
        { parent: 14, feature: null, deleted: false },
      ];
      const id = (index: number) =>
        `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
      for (const [index, node] of nodes.entries()) {
        await tx.execute(sql`INSERT INTO "ProductCategory"
          VALUES (${id(index)}::uuid, ${node.parent === null ? null : id(node.parent)}::uuid,
            ${`synthetic-${index}`}, ${`Synthetic category ${index}`}, ${node.feature},
            ${node.deleted ? new Date(0) : null})`);
      }
      const result = await tx.execute<{
        matches: boolean;
        expected: boolean;
        multiple: boolean;
        expectedMultiple: boolean;
        empty: boolean;
      }>(sql`SELECT
        ${categoryFeatureSql(sql`candidate."id"`, "food")} AS matches,
        coalesce((${categorySummarySql(sql`candidate."id"`)})->>'feature' = 'food', false) AS expected,
        ${categoryFeatureInSql(sql`candidate."id"`, ["food", "tools"])} AS multiple,
        coalesce((${categorySummarySql(sql`candidate."id"`)})->>'feature' IN ('food', 'tools'), false) AS "expectedMultiple",
        ${categoryFeatureInSql(sql`candidate."id"`, [])} AS empty
        FROM (
          SELECT "id" FROM "ProductCategory"
          UNION ALL SELECT NULL::uuid
          UNION ALL SELECT ${id(99)}::uuid
        ) candidate`);
      expect(result.rows).toHaveLength(nodes.length + 2);
      for (const row of result.rows) {
        expect(row.matches).toBe(row.expected);
        expect(row.multiple).toBe(row.expectedMultiple);
        expect(row.empty).toBe(false);
      }
      expect(result.rows.filter((row) => row.matches)).toHaveLength(7);
    });
  });
});
