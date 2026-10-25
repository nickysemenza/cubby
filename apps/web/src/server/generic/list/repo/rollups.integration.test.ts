import { eq } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { expense, purchase, vendor } from "~/server/db/schema";

import { loadDeclaredRollups } from "./field-compiler";

// Failure mode: a rollup that counts a soft-deleted line, sums in double
// precision, or binds its correlation to the wrong row reads plausible but
// wrong totals. The batched form must match the list's correlated one.
describe("declared rollups", () => {
  const ctx = withTestDb();

  it("loads live, exact rollups for many records in one statement", async () => {
    const seller = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic rollup vendor",
    });
    const orders = await Promise.all(
      ["SYNTHETIC-ROLLUP-A", "SYNTHETIC-ROLLUP-B"].map((orderId) =>
        createRepoEntity(ctx, "purchase", {
          vendorId: seller.output.id,
          orderId,
          defaultProjectId: null,
        }),
      ),
    );
    const line = (purchaseId: string, cost: number, name: string) =>
      createRepoEntity(ctx, "expense", {
        name,
        lineKind: "principal",
        trade: "other",
        cost,
        purchaseId,
        projectId: null,
      });
    await line(orders[0]!.output.id, 0.1, "Synthetic tenth");
    await line(orders[0]!.output.id, 0.2, "Synthetic fifth");
    const removed = await line(orders[0]!.output.id, 50, "Synthetic removed");
    await line(orders[1]!.output.id, 7, "Synthetic other order");
    await getDb(ctx.db)
      .update(expense)
      .set({ deletedAt: new Date() })
      .where(eq(expense.id, removed.entityId));

    const purchases = await loadDeclaredRollups(
      ctx.db,
      "purchase",
      purchase,
      orders.map((order) => order.entityId),
      ["expenseCount", "expenseTotal"],
    );
    expect(purchases.get(orders[0]!.entityId)).toEqual(
      new Map<string, number>([
        ["expenseCount", 2],
        // Exact numeric accumulation: double precision would read 0.30000000000000004.
        ["expenseTotal", 0.3],
      ]),
    );
    expect(purchases.get(orders[1]!.entityId)?.get("expenseCount")).toBe(1);

    const vendors = await loadDeclaredRollups(
      ctx.db,
      "vendor",
      vendor,
      [seller.entityId],
      ["purchaseCount", "expenseCount", "spend"],
    );
    expect(vendors.get(seller.entityId)).toEqual(
      new Map<string, number>([
        ["purchaseCount", 2],
        ["expenseCount", 3],
        ["spend", 7.3],
      ]),
    );
  });
});
