import { financialAccountCreateInput } from "@cubby/schemas/financial-account";
import { financialTransactionCreateInput } from "@cubby/schemas/financial-transaction";
import { expenseCreateInput } from "@cubby/schemas/project";
import { purchaseCreateInput, purchaseOut } from "@cubby/schemas/purchase";
import { vendorCreateInput, vendorOut } from "@cubby/schemas/vendor";
import { withTestDb } from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { captureBackgroundQueue } from "~/server/testing/background-queue";
let backgroundQueue: ReturnType<typeof captureBackgroundQueue>;
beforeEach(() => {
  backgroundQueue = captureBackgroundQueue();
});
afterEach(() => backgroundQueue.restore());

import { mock } from "~/lib/test/mock-schema";
import { createExpense } from "~/server/domains/expense/repo/crud";
import { createFinancialAccount } from "~/server/domains/financial-account/repo";
import { createFinancialTransaction } from "~/server/domains/financial-transaction/repo/financial-transaction";
import { executeEntity } from "~/server/entity-kernel";
import { getSearchDocumentEmbeddingText } from "~/server/generic/search/repo/search-document";
import { requireActor } from "~/server/http/request-context";
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
          lineKind: "principal",
          name: "Detached line",
          purchaseId: purchase.id,
          cost: 25,
          date: "2026-07-01",
          trade: "other",
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

    // Financial rows are projected synchronously. Draining any published
    // follow-up work must retain those projections after detach.
    await backgroundQueue.drain(ctx.db);
    const [expenseDoc, transactionDoc] = await Promise.all([
      getSearchDocumentEmbeddingText(ctx.db, "expense", expenseId),
      getSearchDocumentEmbeddingText(
        ctx.db,
        "financialTransaction",
        transactionId,
      ),
    ]);
    expect(expenseDoc).not.toBeNull();
    expect(transactionDoc).not.toBeNull();
  });
});
