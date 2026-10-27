import { workQueueInput } from "@cubby/schemas/work-queue";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { updateExpense } from "~/server/domains/expense/repo/crud";
import { expenseList } from "~/server/domains/expense/repo/lookup";
import { updatePurchase } from "~/server/domains/purchase/repo/purchase";
import { readWorkQueue } from "~/server/domains/work/service/work-queue-read";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import {
  derivedMarkTickets,
  drainStoredDerived,
} from "~/server/testing/background-queue";
import {
  storedQuality,
  storedQualityIds,
} from "~/server/testing/quality.fixtures";
import { makeExpenseInput } from "~/server/testing/repo.fixtures";

import { expenseChecks, EXPENSE_QUALITY_RULES_VERSION } from "./checks/expense";
import { setDataException } from "./exceptions";
import { loadDataQualities, loadQualityBreakdown } from "./hydrate";

// Failure modes: page loaders query each line or allocate the whole ledger;
// reads repair publications; inherited Purchase inputs miss family enrollment;
// evidence changes reopen a member waiver or leave queue membership stale.
describe("stored Expense quality", () => {
  const ctx = withTestDb();
  const refresh = () => drainStoredDerived(ctx.db);
  // A source write marks stored Expense quality with a fresh ticket.
  const generation = async () =>
    Math.max(0, ...(await derivedMarkTickets(ctx.db, "expense.dataQuality")));

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
    const filtered = await expenseList(
      ctx.db,
      {
        dataGap: ["expense_product_resolution"],
      },
      [],
      { pageIndex: 0, pageSize: 10 },
    );
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

  it("serves stored lists and queue outcomes while inherited changes converge through the family", async () => {
    const exempt = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Synthetic initially exempt policy",
      productExpectation: "not_expected",
    });
    const category = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Synthetic inherited merchandise policy",
      productExpectation: "required",
    });
    const vendor = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic inherited quality vendor",
    });
    const order = await createRepoEntity(ctx, "purchase", {
      displayLabel: "Synthetic inherited quality order",
      vendorId: vendor.output.id,
      spendingCategoryId: exempt.shortcode,
    });
    const line = await createRepoEntity(
      ctx,
      "expense",
      makeExpenseInput({
        name: "Synthetic inherited quality line",
        purchaseId: order.output.id,
        cost: null,
        productQuantity: null,
      }),
    );
    const queue = () =>
      readWorkQueue(ctx.db, {
        input: workQueueInput.parse({
          query: line.output.name,
          reason: "expense_product_resolution",
        }),
        memberPartyId: null,
        memberOnly: false,
      });
    const list = () =>
      expenseList(ctx.db, { dataGap: ["expense_product_resolution"] }, [], {
        pageIndex: 0,
        pageSize: 10,
      });
    const quality = async () =>
      (
        await loadDataQualities(ctx.db, "expense", [line.entityId], "stored")
      ).get(line.entityId)!;
    expect((await quality()).status).toBe("not_assessed");
    expect(
      (await loadQualityBreakdown(ctx.db, "expense", line.output.id)).checks,
    ).toContainEqual(
      expect.objectContaining({ check: "expense_cost", state: "gap" }),
    );
    await queue();
    await list();
    expect(await storedQualityIds(ctx.db)).toEqual([]);
    await refresh();
    const published = await storedQuality(ctx.db, line.entityId);
    expect(published?.rulesVersion).toBe(EXPENSE_QUALITY_RULES_VERSION);
    expect((await queue()).items).toEqual([]);
    const before = await generation();
    await updatePurchase(
      ctx.db,
      order.output.id,
      { spendingCategoryId: category.shortcode },
      ctx.actor,
    );
    expect(await generation()).toBeGreaterThan(before);
    // Reads keep the old publication until the enrolled family evaluates descendants.
    expect((await list()).data).toEqual([]);
    expect((await queue()).items).toEqual([]);
    await refresh();
    expect((await quality()).gaps.map((gap) => gap.check)).toContain(
      "expense_product_resolution",
    );
    expect((await list()).data.map((row) => row.id)).toContain(line.output.id);
    expect((await queue()).items).toContainEqual(
      expect.objectContaining({ entity: "expense", id: line.output.id }),
    );

    await setDataException(
      ctx.db,
      {
        entityId: line.output.id,
        check: "expense_product_resolution",
        reason: "unavailable",
        note: "Synthetic historical identity unavailable",
      },
      ctx.actor,
    );
    await refresh();
    expect((await queue()).items).toEqual([]);
    await updatePurchase(
      ctx.db,
      order.output.id,
      { spendingCategoryId: null },
      ctx.actor,
    );
    await refresh();
    await updatePurchase(
      ctx.db,
      order.output.id,
      { spendingCategoryId: category.shortcode },
      ctx.actor,
    );
    await refresh();
    expect((await quality()).exceptions).toContainEqual(
      expect.objectContaining({
        check: "expense_product_resolution",
        state: "active",
      }),
    );
    expect((await list()).data).toEqual([]);
    expect((await queue()).items).toEqual([]);

    const previous = await generation();
    await updateExpense(ctx.db, line.output.id, { cost: 0 }, ctx.actor);
    expect(await generation()).toBeGreaterThan(previous);
    await refresh();
    expect((await quality()).gaps.map((gap) => gap.check)).not.toContain(
      "expense_cost",
    );
  });
});
