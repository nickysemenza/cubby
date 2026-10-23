import { workQueueHouseholdInput } from "@cubby/schemas/work-queue";
import { eq, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { createRepoEntity } from "tooling/factories/repo";
import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import { unwrapDb } from "~/server/db/helpers";
import { entityQuality, job } from "~/server/db/schema";
import { updateExpense } from "~/server/domains/expense/repo/crud";
import * as allocation from "~/server/domains/expense/repo/expense-project-allocation";
import { expenseList } from "~/server/domains/expense/repo/lookup";
import { updatePurchase } from "~/server/domains/purchase/repo/purchase";
import { advanceJob } from "~/server/generic/jobs/service/jobs";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { readWorkQueue } from "~/server/generic/work-queue/service/work-queue-read";
import { makeExpenseInput } from "~/server/testing/repo.fixtures";
import { refreshFamilyHandler } from "~/server/workflows/background-tasks/refresh-families";

import { expenseChecks, EXPENSE_QUALITY_RULES_VERSION } from "./checks/expense";
import { setDataException } from "./exceptions";
import { loadDataQualities, loadQualityBreakdown } from "./hydrate";

// Failure modes: page loaders query each line or allocate the whole ledger;
// reads repair publications; inherited Purchase inputs miss family enrollment;
// evidence changes reopen a member waiver or leave queue membership stale.
describe("stored Expense quality", () => {
  const ctx = withTestDb();
  const refresh = async () => {
    for (let page = 0; page < 8; page++) {
      const [intent] = await unwrapDb(ctx.db)
        .select()
        .from(job)
        .where(eq(job.key, "refresh:quality"));
      if (!intent) throw new Error("Expected quality intent from source write");
      expect(
        await advanceJob(ctx.db, intent.id, {
          "refresh.family": refreshFamilyHandler,
        }),
      ).toBe("succeeded");
      const [current] = await unwrapDb(ctx.db)
        .select()
        .from(job)
        .where(eq(job.id, intent.id));
      if (current?.state === "completed") return;
    }
    throw new Error("Synthetic Expense quality pass exceeded page budget");
  };
  const generation = async () => {
    const [intent] = await unwrapDb(ctx.db)
      .select()
      .from(job)
      .where(eq(job.key, "refresh:quality"));
    if (!intent) throw new Error("Missing quality Job");
    return intent.generation;
  };

  it("batch-loads scoped facts and preserves incurred, zero, quantity and role rules", async () => {
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
    const allocations = vi.spyOn(allocation, "expenseJointAllocationSql");
    const measured = await countTestDbQueries(() =>
      expenseChecks.evaluate(ctx.db, [
        gap.entityId,
        planned.entityId,
        free.entityId,
        unclassified.entityId,
      ]),
    );
    const selections = allocations.mock.calls.map(([ids]) => ids);
    allocations.mockRestore();
    expect(selections).toHaveLength(1);
    const selection = selections[0];
    if (!selection)
      throw new Error("Expense allocation read was not page-scoped");
    const params = new PgDialect()
      .sqlToQuery(sql`${selection}`)
      .params.join(",");
    for (const row of measured.result) expect(params).toContain(row.id);
    expect(measured.queryCount).toBe(1);
    expect(
      (await countTestDbQueries(() => expenseChecks.evaluate(ctx.db, [])))
        .queryCount,
    ).toBe(0);
    const checks = new Map(measured.result.map((row) => [row.id, row.checks]));
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
      readWorkQueue(
        ctx.db,
        null,
        workQueueHouseholdInput.parse({
          query: line.output.name,
          check: "expense_product_resolution",
        }),
        false,
      );
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
    expect(await unwrapDb(ctx.db).select().from(entityQuality)).toEqual([]);
    await refresh();
    const [published] = await unwrapDb(ctx.db)
      .select()
      .from(entityQuality)
      .where(eq(entityQuality.entityId, line.entityId));
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
