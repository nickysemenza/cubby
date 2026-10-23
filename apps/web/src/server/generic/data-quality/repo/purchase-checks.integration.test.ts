import { eq } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { unwrapDb } from "~/server/db/helpers";
import { entityQuality, job } from "~/server/db/schema";
import { updateExpense } from "~/server/domains/expense/repo/crud";
import { purchaseList } from "~/server/domains/purchase/repo/purchase";
import { advanceJob } from "~/server/generic/jobs/service/jobs";
import { readRecordWorkQueue } from "~/server/generic/work-queue/service/work-queue-read";
import { makeExpenseInput } from "~/server/testing/repo.fixtures";
import { refreshFamilyHandler } from "~/server/workflows/background-tasks/refresh-families";

import {
  purchaseChecks,
  PURCHASE_QUALITY_RULES_VERSION,
} from "./checks/purchase";
import { setDataException } from "./exceptions";
import { loadDataQualities, loadQualityBreakdown } from "./hydrate";

// Failures: planned costs pollute settlement checks; reimbursement credits
// alter vendor paperwork; Expense edits fail to enroll quality; reads repair
// stale outcomes or changed comparison inputs reopen a durable member waiver.
describe("stored Purchase quality", () => {
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
    throw new Error("Synthetic Purchase quality pass exceeded page budget");
  };
  const seed = async (label: string, statedTotal: number | null = null) => {
    const vendor = await createRepoEntity(ctx, "vendor", {
      name: `Synthetic ${label} vendor`,
      orderEvidence: "not_expected",
    });
    return createRepoEntity(ctx, "purchase", {
      displayLabel: `Synthetic ${label} order`,
      vendorId: vendor.output.id,
      statedTotal,
    });
  };

  it("loads one ID page and preserves planned, zero and vendor-only paperwork rules", async () => {
    const incurred = await seed("incurred", 12);
    const planned = await seed("planned", 0);
    const empty = await seed("empty", 10);
    await createRepoEntity(
      ctx,
      "expense",
      makeExpenseInput({
        name: "Synthetic incurred unpriced line",
        purchaseId: incurred.output.id,
        cost: null,
      }),
    );
    await createRepoEntity(
      ctx,
      "expense",
      makeExpenseInput({
        name: "Synthetic planned unpriced line",
        purchaseId: planned.output.id,
        cost: null,
        future: true,
      }),
    );
    await createRepoEntity(
      ctx,
      "expense",
      makeExpenseInput({
        name: "Synthetic zero cost line",
        purchaseId: planned.output.id,
        cost: 0,
      }),
    );
    await createRepoEntity(
      ctx,
      "expense",
      makeExpenseInput({
        name: "Synthetic household credit",
        purchaseId: planned.output.id,
        cost: -10,
        economicRole: "reimbursement",
      }),
    );
    const measured = await countTestDbQueries(() =>
      purchaseChecks.evaluate(ctx.db, [
        incurred.entityId,
        planned.entityId,
        empty.entityId,
      ]),
    );
    expect(measured.queryCount).toBe(1);
    expect(
      (await countTestDbQueries(() => purchaseChecks.evaluate(ctx.db, [])))
        .queryCount,
    ).toBe(0);
    const checks = new Map(measured.result.map((row) => [row.id, row.checks]));
    expect(checks.get(incurred.entityId)).toMatchObject({
      unpriced_expense: "gap",
      paperwork_mismatch: "gap",
      purchase_vendor_account: "not_applicable",
    });
    expect(checks.get(planned.entityId)).toMatchObject({
      unpriced_expense: "pass",
      paperwork_mismatch: "pass",
      empty_expenses: "pass",
    });
    expect(checks.get(empty.entityId)).toMatchObject({
      paperwork_mismatch: "pass",
      empty_expenses: "gap",
    });
    expect(
      (await purchaseChecks.evaluate(ctx.db, [empty.entityId])).map(
        (row) => row.id,
      ),
    ).toEqual([empty.entityId]);
  });

  it("keeps reads stored until Expense-change convergence and never reopens a paperwork waiver", async () => {
    const order = await seed("convergence", 10);
    const line = await createRepoEntity(
      ctx,
      "expense",
      makeExpenseInput({
        name: "Synthetic converging line",
        purchaseId: order.output.id,
        cost: 10,
      }),
    );
    const quality = async () =>
      (await loadDataQualities(ctx.db, "purchase", [order.entityId])).get(
        order.entityId,
      )!;
    const list = () =>
      purchaseList(ctx.db, { dataGap: ["paperwork_mismatch"] }, [], {
        pageIndex: 0,
        pageSize: 20,
      });
    const queue = async () => {
      const result = await readRecordWorkQueue(
        ctx.db,
        null,
        order.output.id,
        false,
      );
      return result.items.filter(
        (item) => item.key === `purchasesNotReconciling:${order.output.id}`,
      );
    };
    expect((await quality()).status).toBe("not_assessed");
    await list();
    await queue();
    expect(
      (await loadQualityBreakdown(ctx.db, "purchase", order.output.id)).checks,
    ).toContainEqual(
      expect.objectContaining({
        check: "paperwork_mismatch",
        state: "satisfied",
      }),
    );
    expect(await unwrapDb(ctx.db).select().from(entityQuality)).toEqual([]);
    await refresh();
    const [published] = await unwrapDb(ctx.db)
      .select()
      .from(entityQuality)
      .where(eq(entityQuality.entityId, order.entityId));
    expect(published?.rulesVersion).toBe(PURCHASE_QUALITY_RULES_VERSION);
    const [before] = await unwrapDb(ctx.db)
      .select()
      .from(job)
      .where(eq(job.key, "refresh:quality"));
    await updateExpense(ctx.db, line.output.id, { cost: 7 }, ctx.actor);
    const [after] = await unwrapDb(ctx.db)
      .select()
      .from(job)
      .where(eq(job.key, "refresh:quality"));
    expect(after!.generation).toBeGreaterThan(before!.generation);
    expect((await list()).data).toEqual([]);
    expect(await queue()).toEqual([]);
    await refresh();
    expect((await list()).data.map((row) => row.id)).toContain(order.output.id);
    const queued = await queue();
    expect(queued).toContainEqual(
      expect.objectContaining({ entity: "purchase", id: order.output.id }),
    );
    await setDataException(
      ctx.db,
      {
        entityId: order.output.id,
        check: "paperwork_mismatch",
        reason: "expected_mismatch",
        note: "Synthetic historical receipt residual accepted",
      },
      ctx.actor,
    );
    await refresh();
    await updateExpense(ctx.db, line.output.id, { cost: 3 }, ctx.actor);
    await refresh();
    expect((await quality()).exceptions).toContainEqual(
      expect.objectContaining({ check: "paperwork_mismatch", state: "active" }),
    );
    expect((await list()).data).toEqual([]);
    expect(await queue()).toEqual([]);
  });
});
