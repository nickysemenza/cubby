import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { describe, expect, it } from "vitest";

import { expense, purchase } from "~/server/db/schema";

import { outer, related } from "./related";

// A single-table select is where Drizzle renders bare columns: the rollup
// must still name the outer row and its own aliased rows unambiguously.
const render = (field: Parameters<ReturnType<typeof drizzle>["select"]>[0]) =>
  drizzle.mock().select(field).from(purchase).toSQL().sql;

describe("related rollups", () => {
  it("qualifies the outer row and aliases the related table", () => {
    const text = render({
      total: related(
        expense,
        (e) => sql`${e.purchaseId} = ${outer(purchase.id)}`,
      ).sum((e) => e.cost),
    });
    expect(text).toContain(`"Purchase"."id"`);
    expect(text).toMatch(
      /\(SELECT COALESCE\(sum\("r\d+"\."cost"\), 0\)::double precision FROM "Expense" "r\d+" WHERE \("r\d+"\."purchaseId" = "Purchase"\."id"\) AND \("r\d+"\."deletedAt" IS NULL\)\)/,
    );
  });

  it("keeps every joined step live unless it opts out", () => {
    const text = render({
      count: related(
        expense,
        (e) => sql`${e.purchaseId} = ${outer(purchase.id)}`,
      )
        .where((e) => sql`${e.cost} IS NULL`)
        .join(purchase, (p, e) => sql`${p.id} = ${e.purchaseId}`)
        .count(),
      all: related(
        expense,
        (e) => sql`${e.purchaseId} = ${outer(purchase.id)}`,
        {
          includeDeleted: true,
        },
      ).exists(),
    });
    expect(text).toMatch(
      /INNER JOIN "Purchase" "r\d+" ON "r\d+"\."id" = "r\d+"\."purchaseId" AND "r\d+"\."deletedAt" IS NULL/,
    );
    expect(text).toMatch(/\("r\d+"\."cost" IS NULL\)/);
    expect(text).toMatch(
      /EXISTS \(SELECT 1 FROM "Expense" "r\d+" WHERE \("r\d+"\."purchaseId" = "Purchase"\."id"\)\)/,
    );
  });
});
