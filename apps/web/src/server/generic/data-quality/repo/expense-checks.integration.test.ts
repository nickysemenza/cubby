import { workQueueInput } from "@cubby/schemas/work-queue";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { insertFieldsFixture as insertWithShortcode } from "~/server/ai/fields/fields.fixtures";
import { updateExpense } from "~/server/domains/expense/repo/crud";
import { expenseScaffold } from "~/server/domains/expense/repo/lookup";
import { readWorkQueue } from "~/server/domains/work/service/work-queue-read";
import { drainStoredDerived } from "~/server/testing/background-queue";
import { storedQuality } from "~/server/testing/quality.fixtures";
import { makeExpenseInput } from "~/server/testing/repo.fixtures";

import { expenseChecks } from "./checks/expense";

// Failure modes: page loaders query each line or allocate the whole ledger;
// reads repair publications; inherited Purchase inputs miss family enrollment;
// evidence changes reopen a member waiver or leave queue membership stale.
describe("stored Expense quality", () => {
  const ctx = withTestDb();
  const refresh = () => drainStoredDerived(ctx.db);
  // A source write marks stored Expense quality with a fresh ticket.

  it("publishes unclassified principal item lines to Research without overriding category intent", async () => {
    const vendor = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic unclassified import vendor",
    });
    const order = await createRepoEntity(ctx, "purchase", {
      displayLabel: "Synthetic unclassified import",
      vendorId: vendor.output.id,
    });
    const exempt = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Synthetic no-product policy",
      productExpectation: "not_expected",
    });
    const forbidden = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Synthetic no-product classification",
      productExpectation: "not_allowed",
    });
    const inputs = [
      { name: "Synthetic unclassified item" },
      { name: "Synthetic service", costType: "services" },
      { name: "Synthetic allocation", lineBasis: "allocation" },
      { name: "Synthetic shipping", lineKind: "shipping" },
      { name: "Synthetic exempt item", spendingCategoryId: exempt.shortcode },
      {
        name: "Synthetic forbidden item",
        spendingCategoryId: forbidden.shortcode,
      },
    ] as const;
    const lines = [];
    for (const input of inputs)
      lines.push(
        await createRepoEntity(
          ctx,
          "expense",
          makeExpenseInput({
            purchaseId: order.output.id,
            productId: null,
            ...input,
          }),
        ),
      );
    await refresh();
    const [principal, ...excluded] = lines;
    if (!principal) throw new Error("Synthetic principal line missing");
    expect(
      (await storedQuality(ctx.db, principal.entityId))?.checks,
    ).toMatchObject({ expense_product_resolution: "gap" });
    for (const line of excluded)
      expect(
        (await storedQuality(ctx.db, line.entityId))?.checks,
      ).toMatchObject({ expense_product_resolution: "not_applicable" });
    const filtered = await expenseScaffold.read(ctx.db, {
      filters: {
        dataGap: ["expense_product_resolution"],
      },
      sorts: [],
      pagination: { pageIndex: 0, pageSize: 10 },
    });
    expect(filtered.data.map((line) => line.id)).toEqual([principal.output.id]);
    const queue = await readWorkQueue(ctx.db, {
      input: workQueueInput.parse({
        reason: "expense_product_resolution",
        pageSize: 1,
      }),
      memberPartyId: null,
      memberOnly: false,
    });
    expect(queue.meta.totalCount).toBe(1);
    expect(queue.items[0]?.id).toBe(principal.output.id);
    const service = excluded[0];
    if (!service) throw new Error("Synthetic service line missing");
    const categoryWork = () =>
      readWorkQueue(ctx.db, {
        input: workQueueInput.parse({
          reason: "expense_spending_category",
          query: service.output.name,
        }),
        memberPartyId: null,
        memberOnly: false,
      });
    // Category research must stand alone when a service needs no Product.
    expect((await categoryWork()).items.map((item) => item.id)).toEqual([
      service.output.id,
    ]);
    await updateExpense(
      ctx.db,
      service.output.id,
      { spendingCategoryId: exempt.shortcode },
      ctx.actor,
    );
    await refresh();
    expect((await categoryWork()).items).toEqual([]);
  });

  it("loads scoped facts and preserves incurred, zero, quantity and role rules", async () => {
    const category = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Synthetic merchandise policy",
      productExpectation: "required",
    });
    const gap = await createRepoEntity(
      ctx,
      "expense",
      makeExpenseInput({
        name: "Synthetic unpriced merchandise",
        cost: null,
        spendingCategoryId: category.shortcode,
        productQuantity: null,
      }),
    );
    const planned = await createRepoEntity(
      ctx,
      "expense",
      makeExpenseInput({
        name: "Synthetic planned merchandise",
        cost: null,
        future: true,
        spendingCategoryId: category.shortcode,
        productQuantity: null,
      }),
    );
    const free = await createRepoEntity(
      ctx,
      "expense",
      makeExpenseInput({
        name: "Synthetic zero cost service",
        cost: 0,
        costType: "services",
        productQuantity: null,
      }),
    );
    const unclassified = await createRepoEntity(
      ctx,
      "expense",
      makeExpenseInput({
        name: "Synthetic unresolved receipt role",
        lineKind: "unclassified",
      }),
    );
    const evaluated = await expenseChecks.evaluate(ctx.db, [
      gap.entityId,
      planned.entityId,
      free.entityId,
      unclassified.entityId,
    ]);
    expect(await expenseChecks.evaluate(ctx.db, [])).toEqual([]);
    const checks = new Map(evaluated.map((row) => [row.id, row.checks]));
    expect(checks.get(gap.entityId)).toMatchObject({
      expense_cost: "gap",
      expense_spending_category: "pass",
      expense_quantity: "gap",
      expense_product_resolution: "gap",
    });
    expect(checks.get(planned.entityId)).toMatchObject({
      expense_cost: "not_applicable",
      expense_spending_category: "not_applicable",
      expense_quantity: "not_applicable",
      expense_product_resolution: "gap",
    });
    expect(checks.get(free.entityId)).toMatchObject({
      expense_cost: "pass",
      expense_quantity: "not_applicable",
      expense_product_resolution: "not_applicable",
    });
    expect(checks.get(unclassified.entityId)?.expense_receipt_role).toBe("gap");
  });
});
