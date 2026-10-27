import { entityFieldEnvelopeSchemas } from "@cubby/schemas/entity-field-envelopes";
import { rawFinancialTransactionOut } from "@cubby/schemas/financial-transaction-raw-read";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import {
  type linkExpensesToPurchaseInput,
  splitExpenseDelta,
  type splitExpenseInput,
} from "@cubby/schemas/purchase";
import type { RawPurchaseOut } from "@cubby/schemas/purchase-raw-read";

import { purchaseContract } from "~/contracts/purchase.contract";
import { suggestSettlementMatch } from "~/server/ai/settlement-candidate-rank";
import { withTransactionDatabase } from "~/server/db/helpers";
import { recomputeRecipesForPriceAffectedProducts } from "~/server/domains/expense/repo/price-affected-recipes";
import { expenseLineRoleClassifier } from "~/server/domains/expense/service/expense-line-role";
import {
  getPurchaseByShortcode,
  linkExpensesToPurchase,
  reclassifyPurchaseDocument,
  splitExpense,
} from "~/server/domains/purchase/repo/purchase";
import {
  checkLinkExpensesFor,
  checkSplitFor,
  explicitlyAttachedProductIds,
  listLinkExpenseCandidates,
  loadSplitOriginal,
} from "~/server/domains/purchase/repo/purchase-finance-actions";
import {
  composeLinkProductCandidates,
  LINK_PRODUCT_LIMIT,
} from "~/server/domains/purchase/repo/purchase-link-draft";
import { checkSettlementAllocationDraft } from "~/server/domains/purchase/repo/purchase-settlement-allocation";
import { listPurchaseSettlementCandidates } from "~/server/domains/purchase/repo/purchase-settlement-candidates";
import { composeSettlementReview } from "~/server/domains/purchase/repo/purchase-settlement-review";
import { startSplitDraft } from "~/server/domains/purchase/repo/purchase-split-draft";
import {
  aiCallRunInput,
  ensureRun,
} from "~/server/domains/run/repo/ensure-run";
import { executeEntity, executeEntityAs } from "~/server/entity-kernel";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { createAppError } from "~/server/errors/app-error";
import { ENTITY_KERNEL_BINDINGS } from "~/server/generated/entity-kernel-bindings.gen";
import { recordChange } from "~/server/generic/changes/repo/change";
import { readPublicEntityRows } from "~/server/generic/derived/service/public-read";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";
import { bindWorkflow, workflow } from "~/server/workflows/runtime";

export const linkExpensesToPurchaseWorkflow = bindWorkflow(
  workflow<EntityKernelContext, typeof linkExpensesToPurchaseInput._output>(
    "purchase.link",
  )
    .commit("link", ({ context }, { input }) =>
      withTransactionDatabase(context.db, async (transactionDb) => {
        const result = await linkExpensesToPurchase(
          transactionDb,
          input,
          context.actorContext,
        );
        await recordChange(transactionDb, {
          kind: "source",
          categories: ["expense"],
        });
        return result;
      }),
    )
    .output(({ link }) => link),
);

export const splitExpenseWorkflow = bindWorkflow(
  workflow<EntityKernelContext, typeof splitExpenseInput._output>(
    "purchase.split",
  )
    .commit("split", ({ context }, { input }) =>
      splitExpense(
        context.db,
        input,
        context.actorContext,
        expenseLineRoleClassifier(),
      ),
    )
    .effect("pricing", async ({ context }, { split }) => {
      if (split.priceAffectedProductIds.length > 0) {
        await recomputeRecipesForPriceAffectedProducts(
          context.db,
          context.services.recipeCosting,
          split.priceAffectedProductIds,
          "purchase.split",
        );
      }
    })
    .output(({ split }) => split.items),
);

async function loadSettlementTransaction(
  context: EntityKernelContext,
  transactionId: string,
) {
  const result =
    await ENTITY_KERNEL_BINDINGS.financialTransaction.repository.get(
      context,
      parseShortcodeFor("financialTransaction", transactionId),
    );
  if (!result)
    throw new Error(
      "Entity kernel returned the wrong financial transaction detail",
    );
  return rawFinancialTransactionOut.parse(result);
}

async function readPurchase(context: EntityKernelContext, row: RawPurchaseOut) {
  return (
    await readPublicEntityRows({
      db: context.db,
      entity: "purchase",
      projection: "detail",
      rows: [row],
    })
  )[0]!;
}

async function readSplitExpenses(
  context: EntityKernelContext,
  rows: Awaited<ReturnType<typeof splitExpenseWorkflow>>,
) {
  return readPublicEntityRows({
    db: context.db,
    entity: "expense",
    projection: "detail",
    rows,
  });
}

export const purchaseHandlers = implementOperationDomain(purchaseContract, {
  settlementCandidates: async (context, input) => {
    const purchase = await getPurchaseByShortcode(context.db, input.purchaseId);
    if (!purchase)
      throw createAppError("PURCHASE_NOT_FOUND", "Purchase not found");
    const candidates = await listPurchaseSettlementCandidates(
      context.db,
      input.purchaseId,
    );
    const ranked = await Promise.all(
      candidates.map(async ({ transactionId, ...rank }) => ({
        ...rank,
        transaction: await loadSettlementTransaction(context, transactionId),
      })),
    );
    const review = composeSettlementReview(
      {
        id: input.purchaseId,
        date: purchase.date,
        statedTotal: purchase.statedTotal,
      },
      ranked,
    );
    const transactions = await readPublicEntityRows({
      db: context.db,
      entity: "financialTransaction",
      projection: "detail",
      rows: review.candidates.map((candidate) => candidate.transaction),
    });
    return {
      advisory: true as const,
      ...review,
      candidates: review.candidates.map((candidate, index) => ({
        ...candidate,
        transaction: transactions[index]!,
      })),
    };
  },
  checkSettlementAllocation: async (context, input) => {
    const transaction = await loadSettlementTransaction(
      context,
      input.transactionId,
    );
    return checkSettlementAllocationDraft(
      input.allocations,
      transaction.amount,
    );
  },
  suggestSettlementMatch: async (context, input) => {
    const purchase = await getPurchaseByShortcode(context.db, input.purchaseId);
    if (!purchase)
      throw createAppError("PURCHASE_NOT_FOUND", "Purchase not found");
    // Recomputed here, never taken from the client: the tie is a server fact.
    return suggestSettlementMatch({
      subject: {
        vendorName: purchase.vendorName,
        date: purchase.date,
        statedTotal: purchase.statedTotal,
        orderId: purchase.orderId,
      },
      ranks: await listPurchaseSettlementCandidates(
        context.db,
        input.purchaseId,
      ),
      loadTransaction: (id) => loadSettlementTransaction(context, id),
      openUsage: async () => ({
        db: context.db,
        runId: await ensureRun(
          context.db,
          context.actorContext,
          aiCallRunInput(context.actorContext),
        ),
        operation: "purchase.suggestSettlementMatch",
        entity: { entityKind: "purchase", entityId: input.purchaseId },
        cacheStatus: "none",
      }),
    });
  },
  link: async (context, input) =>
    readPurchase(context, await linkExpensesToPurchaseWorkflow(context, input)),
  split: async (context, input) =>
    readSplitExpenses(context, await splitExpenseWorkflow(context, input)),
  splitStart: async (context, input) =>
    startSplitDraft(await loadSplitOriginal(context.db, input.expenseId)),
  checkSplit: (context, input) =>
    checkSplitFor(
      context.db,
      input,
      context.actorContext,
      expenseLineRoleClassifier(),
    ),
  linkExpenseCandidates: (context, input) =>
    listLinkExpenseCandidates(context.db, input),
  checkLinkExpenses: (context, input) =>
    checkLinkExpensesFor(context.db, input),
  linkProductCandidates: async (context, input) => {
    const attached = await explicitlyAttachedProductIds(
      context.db,
      input.purchaseId,
    );
    // Loaded on demand: the product search pulls in the semantic fallback.
    const { searchProducts } =
      await import("~/server/domains/product/operations/product.server");
    const found = await searchProducts(context, {
      filters: { nameFilter: input.search?.trim() || undefined },
      pagination: {
        pageIndex: 0,
        // Room for what is hidden, so attached products never shorten the page.
        pageSize: LINK_PRODUCT_LIMIT + attached.size,
      },
      sort: [{ orderBy: "name", direction: "asc" }],
    });
    return composeLinkProductCandidates(
      found.items,
      attached,
      LINK_PRODUCT_LIMIT,
    );
  },
  attachProducts: async (context, input) => {
    // The kernel's own relation write, so the link is audited and settled exactly as the
    // generic attach is.
    const result = await executeEntity(context, {
      action: "attach",
      entity: "purchase",
      relation: "products",
      id: input.purchaseId,
      items: input.productIds.map((id) => ({ id })),
    });
    if (!("relation" in result))
      throw new Error("Entity kernel returned the wrong attach result");
    return result.result;
  },
  splitWithDelta: async (context, input) => {
    // Read before the split runs — the original row is soft-deleted by the
    // time `purchase.split` returns, so its cost has to be captured first.
    const original = await executeEntityAs(context, "get", {
      entity: "expense",
      id: input.expenseId,
      missing: "error",
    });
    if (!original.item)
      throw new Error("Entity kernel returned the wrong expense detail");
    const items = await splitExpenseWorkflow(context, input);
    const { originalCost, partsSum, delta } = splitExpenseDelta(
      entityFieldEnvelopeSchemas.expense.detail.parse(original.item).cost,
      input.parts.map((part) => part.cost),
    );
    return {
      items: await readSplitExpenses(context, items),
      originalCost,
      partsSum,
      delta,
    };
  },
  reclassifyDocument: async (context, input) =>
    readPurchase(
      context,
      await reclassifyPurchaseDocument(context.db, input, context.actorContext),
    ),
});
