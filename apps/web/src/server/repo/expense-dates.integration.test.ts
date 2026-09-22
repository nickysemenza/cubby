import { expenseCreateInput } from "@cubby/schemas/project";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { UNKNOWN_OWNERSHIP } from "~/lib/tool-timeline";
import { expense } from "~/server/db/schema";

import { getDb } from "./database-helpers";
import { createExpense, getExpenseByShortcode, updateExpense } from "./expense";
import { expenseAnalytics, expenseMonthlySummary } from "./expense/analytics";
import { updateExpensesInBulk } from "./expense/crud";
import {
  getProductMovementTimeline,
  toEntityTimeline,
} from "./product/movement-timeline";
import { loadProductOwnershipTimelines } from "./product/ownership";
import { loadProductQuantityLedgers } from "./product/quantity-ledger";
import {
  createProductFixture,
  makeExpenseInput,
  makeProductInput,
} from "./repo.fixtures";

describe("unknown expense dates", () => {
  const ctx = withTestDb();

  it.each([12, -12, null])(
    "refuses an unknown date with cost %s at every write boundary",
    async (cost) => {
      const input = makeExpenseInput({ cost, date: null });
      expect(expenseCreateInput.safeParse(input).success).toBe(false);
      await expect(createExpense(ctx.db, input, ctx.actor)).rejects.toThrow(
        "A date is required",
      );
      const { output: undated } = await createExpense(
        ctx.db,
        makeExpenseInput({ cost: 0, date: null }),
        ctx.actor,
      );
      await expect(
        updateExpense(ctx.db, undated.id, { cost }, ctx.actor),
      ).rejects.toThrow("A date is required");
      await expect(
        getDb(ctx.db)
          .update(expense)
          .set({ cost })
          .where(eq(expense.shortcode, undated.id)),
      ).rejects.toThrow(/Expense_date_cost_check|Failed query/);
      expect(await getExpenseByShortcode(ctx.db, undated.id)).toMatchObject({
        cost: 0,
        date: null,
      });
      expect(
        await updateExpense(
          ctx.db,
          undated.id,
          { cost, date: "2026-01-02" },
          ctx.actor,
        ),
      ).toMatchObject({ output: { cost, date: "2026-01-02" } });
    },
  );

  it("clears a zero-cost selection and refuses a mixed-cost selection atomically", async () => {
    const { output: free } = await createExpense(
      ctx.db,
      makeExpenseInput({ cost: 0 }),
      ctx.actor,
    );
    const { output: paid } = await createExpense(
      ctx.db,
      makeExpenseInput({ cost: 20 }),
      ctx.actor,
    );
    await expect(
      updateExpensesInBulk(
        ctx.db,
        [free.id, paid.id],
        { date: null, costType: "tools" },
        ctx.actor,
      ),
    ).rejects.toThrow("A date is required");
    expect(await getExpenseByShortcode(ctx.db, free.id)).toMatchObject({
      date: "2024-01-15",
      costType: "materials",
    });
    await updateExpensesInBulk(ctx.db, [free.id], { date: null }, ctx.actor);
    expect(await getExpenseByShortcode(ctx.db, free.id)).toMatchObject({
      date: null,
    });
    await updateExpensesInBulk(
      ctx.db,
      [free.id],
      { trade: "other" },
      ctx.actor,
    );
    expect(await getExpenseByShortcode(ctx.db, free.id)).toMatchObject({
      date: null,
    });
  });

  it("keeps undated free acquisitions and discards in history without inventing ownership dates", async () => {
    const product = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Undated workshop tool" }),
      ctx.actor,
    );
    const { output: dated } = await createExpense(
      ctx.db,
      makeExpenseInput({
        productId: product.id,
        productQuantity: 1,
        date: "2026-01-02",
        vendor: "Workshop supplies",
      }),
      ctx.actor,
    );
    for (const productQuantity of [2, -1]) {
      await createExpense(
        ctx.db,
        makeExpenseInput({
          productId: product.id,
          productQuantity,
          cost: 0,
          date: null,
          purchaseId: productQuantity > 0 ? dated.purchaseId : null,
        }),
        ctx.actor,
      );
    }
    const input = {
      ids: [product.id],
      filters: {},
      order: "desc" as const,
      pagination: { pageIndex: 0, pageSize: 200 },
    };
    const timeline = await getProductMovementTimeline(ctx.db, input);
    expect(timeline.groups.map((group) => group.date)).toEqual([
      "2026-01-02",
      null,
      null,
    ]);
    expect(timeline.summary.movementCount).toBe(3);
    expect(
      timeline.groups
        .flatMap((group) => group.movements)
        .reduce((total, line) => total + (line.signedQuantity ?? 0), 0),
    ).toBe(2);
    expect(timeline.extent).toEqual({ from: "2026-01-02", to: "2026-01-02" });
    expect(toEntityTimeline(timeline).rows?.[0]?.markers).toHaveLength(1);
    const undatedPurchase = timeline.groups.find(
      (group) => group.date === null && group.purchase !== null,
    );
    expect(undatedPurchase?.purchase?.date).toBe("2026-01-02");
    expect(
      toEntityTimeline(timeline).groups.find(
        (group) => group.key === undatedPurchase?.key,
      )?.events[0]?.detail,
    ).toContain("Purchase date 2026-01-02");
    const filtered = await getProductMovementTimeline(ctx.db, {
      ...input,
      from: "2026-01-01",
    });
    expect(
      filtered.groups
        .flatMap((group) => group.movements)
        .map((line) => line.expenseId),
    ).toEqual([dated.id]);
    const ownership = await loadProductOwnershipTimelines(getDb(ctx.db), [
      product.entityId,
    ]);
    expect(ownership.get(product.entityId)).toEqual(UNKNOWN_OWNERSHIP);
    const quantities = await loadProductQuantityLedgers(ctx.db, [
      product.entityId,
    ]);
    expect(quantities.get(product.entityId)).toMatchObject({
      acquiredUnits: 3,
      exitedUnits: 1,
      expectedQuantity: 2,
    });
    const analytics = await expenseAnalytics(ctx.db, { productId: product.id });
    expect(analytics.summary.count).toBe(3);
    expect(analytics.monthly).toEqual([
      expect.objectContaining({ month: "2026-01", count: 1 }),
    ]);
    expect(
      await expenseMonthlySummary(ctx.db, { productId: product.id }),
    ).toEqual(analytics.monthly);
  });
});
