import { financialAccountCreateInput } from "@cubby/schemas/financial-account";
import { financialTransactionCreateInput } from "@cubby/schemas/financial-transaction";
import { expenseCreateInput } from "@cubby/schemas/project";
import { purchaseCreateInput, purchaseOut } from "@cubby/schemas/purchase";
import { vendorCreateInput, vendorOut } from "@cubby/schemas/vendor";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { mock } from "~/lib/test/mock-schema";
import { executeEntity } from "~/server/entity-kernel";
import {
  getBackgroundBatchDetail,
  listBackgroundBatches,
} from "~/server/repo/background-jobs";
import { createExpense } from "~/server/repo/expense";
import { createFinancialAccount } from "~/server/repo/financial-account";
import { createFinancialTransaction } from "~/server/repo/financial-transaction";
import { requireActor } from "~/server/request-context";
import { createTestRequestContext } from "~/server/testing/request-context";

describe("purchase deletion embedding fanout", () => {
  const ctx = withTestDb();
  const workflowContext = () =>
    requireActor(
      createTestRequestContext(ctx.db, {
        auth: { userId: ctx.actor.userId },
      }),
    );

  it("reindexes expenses and transactions detached by purchase delete", async () => {
    const context = workflowContext();
    const vendorResult = await executeEntity(context, {
      action: "create",
      entity: "vendor",
      data: mock(vendorCreateInput, {
        overrides: { name: "Detach Supply" },
      }),
    });
    if (vendorResult.action !== "create") throw new Error("unreachable");
    const vendor = vendorOut.parse(vendorResult.item);

    const purchaseResult = await executeEntity(context, {
      action: "create",
      entity: "purchase",
      data: mock(purchaseCreateInput, {
        overrides: {
          vendorId: vendor.id,
          orderId: "DETACH-1",
          pendingImageIds: [],
        },
      }),
    });
    if (purchaseResult.action !== "create") throw new Error("unreachable");
    const purchase = purchaseOut.parse(purchaseResult.item);

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

    await executeEntity(context, {
      action: "delete",
      entity: "purchase",
      ids: [purchase.id],
    });

    const batches = await listBackgroundBatches(ctx.db, 50);
    const purchaseDeleteMetadata = z.object({
      source: z.literal("purchase.delete"),
    });
    const details = await Promise.all(
      batches
        .filter(
          (batch) =>
            batch.kind === "entity-embedding.refresh" &&
            purchaseDeleteMetadata.safeParse(batch.metadata).success,
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
