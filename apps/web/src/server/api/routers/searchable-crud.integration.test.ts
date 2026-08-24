import { financialAccountCreateInput } from "@cubby/schemas/financial-account";
import { financialTransactionCreateInput } from "@cubby/schemas/financial-transaction";
import { expenseCreateInput } from "@cubby/schemas/project";
import { purchaseCreateInput } from "@cubby/schemas/purchase";
import { vendorCreateInput } from "@cubby/schemas/vendor";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { mock } from "~/lib/test/mock-schema";
import { createTestCaller } from "~/server/api/trpc";
import {
  getBackgroundBatchDetail,
  listBackgroundBatches,
} from "~/server/repo/background-jobs";
import { createExpense } from "~/server/repo/expense";
import { createFinancialAccount } from "~/server/repo/financial-account";
import { createFinancialTransaction } from "~/server/repo/financial-transaction";
import { purchaseRouter } from "./purchase";
import { vendorRouter } from "./vendor";

describe("purchase deletion embedding fanout", () => {
  const ctx = withTestDb();

  /**
   * The generic CRUD contract is covered by the entity kernel. Purchase
   * deletion additionally detaches its Expenses and FinancialTransactions,
   * whose embeddings include the purchase identity, so its repository adapter
   * must explicitly enqueue their reindexing.
   */
  it("purchase delete reindexes the expenses and transactions it detaches", async () => {
    const vendor = await createTestCaller(vendorRouter, ctx.db).create(
      mock(vendorCreateInput, { overrides: { name: "Detach Supply" } }),
    );
    const caller = createTestCaller(purchaseRouter, ctx.db);
    const purchase = await caller.create(
      mock(purchaseCreateInput, {
        overrides: {
          vendorId: vendor.id,
          orderId: "DETACH-1",
          pendingImageIds: [],
        },
      }),
    );

    const { entityId: expenseId } = await createExpense(
      ctx.db,
      mock(expenseCreateInput, {
        overrides: {
          name: "Detached line",
          purchaseId: purchase.id,
          cost: 25,
          date: "2026-07-01",
        },
      }),
      ctx.actor,
    );
    const { output: account } = await createFinancialAccount(
      ctx.db,
      mock(financialAccountCreateInput, {
        overrides: { name: "Detach Card", provisional: false },
      }),
      ctx.actor,
    );
    const { entityId: transactionId } = await createFinancialTransaction(
      ctx.db,
      mock(financialTransactionCreateInput, {
        overrides: {
          accountId: account.id,
          purchaseId: purchase.id,
          kind: "purchase",
          status: "posted",
          amount: 25,
          transactionDate: "2026-07-01",
          postedDate: "2026-07-02",
        },
      }),
      ctx.actor,
    );

    await caller.delete({ ids: [purchase.id] });

    const batches = await listBackgroundBatches(ctx.db, 50);
    const details = await Promise.all(
      batches
        .filter(
          (batch) =>
            batch.kind === "entity-embedding.refresh" &&
            (batch.metadata as { source?: string } | null)?.source ===
              "purchase.delete",
        )
        .map((batch) => getBackgroundBatchDetail(ctx.db, batch.id)),
    );
    const payloads = details.flatMap(
      (detail) => detail?.jobs.map((job) => job.payload) ?? [],
    );
    expect(payloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entityType: "expense", entityId: expenseId }),
        expect.objectContaining({
          entityType: "financialTransaction",
          entityId: transactionId,
        }),
      ]),
    );
  });
});
