import { sql } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { unwrapDb } from "~/server/db/helpers";
import { updateExpense } from "~/server/domains/expense/repo/crud";
import { purchaseList } from "~/server/domains/purchase/repo/purchase";
import { readRecordWorkQueue } from "~/server/domains/work/service/work-queue-read";
import {
  derivedMarkTickets,
  drainStoredDerived,
} from "~/server/testing/background-queue";
import { makeExpenseInput } from "~/server/testing/repo.fixtures";

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
  const refresh = () => drainStoredDerived(ctx.db);
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
    const evaluated = await purchaseChecks.evaluate(ctx.db, [
      incurred.entityId,
      planned.entityId,
      empty.entityId,
    ]);
    expect(await purchaseChecks.evaluate(ctx.db, [])).toEqual([]);
    const checks = new Map(evaluated.map((row) => [row.id, row.checks]));
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
      (
        await loadDataQualities(ctx.db, "purchase", [order.entityId], "stored")
      ).get(order.entityId)!;
    const list = () =>
      purchaseList(ctx.db, { dataGap: ["paperwork_mismatch"] }, [], {
        pageIndex: 0,
        pageSize: 20,
      });
    const queue = async () => {
      const result = await readRecordWorkQueue(ctx.db, {
        id: order.output.id,
        memberPartyId: null,
        memberOnly: false,
      });
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
    await refresh();
    const [published] = await unwrapDb(ctx.db)
      .execute(
        sql`SELECT value->>'rulesVersion' AS "rulesVersion" FROM "DerivedValue"
          WHERE "entityId" = ${order.entityId} AND key = 'dataQuality'`,
      )
      .then((result) => result.rows as { rulesVersion: string }[]);
    expect(Number(published?.rulesVersion)).toBe(
      PURCHASE_QUALITY_RULES_VERSION,
    );
    // An Expense edit marks its Purchase's stored quality (ADR 0021).
    expect(
      await derivedMarkTickets(ctx.db, "purchase.dataQuality", order.entityId),
    ).toEqual([]);
    await updateExpense(ctx.db, line.output.id, { cost: 7 }, ctx.actor);
    expect(
      await derivedMarkTickets(ctx.db, "purchase.dataQuality", order.entityId),
    ).toHaveLength(1);
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
