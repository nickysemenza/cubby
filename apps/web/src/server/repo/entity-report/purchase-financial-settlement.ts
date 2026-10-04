import type { FinancialTransactionOut } from "@cubby/schemas/financial-transaction";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { PurchaseOut } from "@cubby/schemas/purchase";

import { formatCurrency } from "~/lib/utils";
import type { Database } from "~/server/db";
import { createAppError } from "~/server/errors/app-error";
import { listFinancialTransactions } from "~/server/repo/financial-transaction";
import { listAll } from "~/server/repo/list-all";
import { settlementLabel } from "~/server/repo/list-display-labels";
import { getPurchaseByShortcode } from "~/server/repo/purchase";

import { optionColor, sectionBlocks, sectionOut } from "./finance-section";

/**
 * Scoped to one purchase, the slice is the honest figure — the full charge settled several
 * orders, and showing it here would overstate what this one received. The whole amount stays
 * beside it so the split is legible.
 */
const linkedItem = (
  purchaseId: string,
  transaction: FinancialTransactionOut,
) => {
  const slice =
    transaction.allocations.length > 1
      ? transaction.allocations.find(
          (allocation) => allocation.purchaseId === purchaseId,
        )
      : undefined;
  return {
    id: transaction.id,
    title: transaction.displayName,
    lines: [
      [
        transaction.accountName,
        transaction.status,
        transaction.postedDate ?? transaction.transactionDate,
      ]
        .filter((part) => part)
        .join(" · "),
    ],
    amount: slice?.amount ?? transaction.amount,
    amountNote: slice ? `of ${formatCurrency(transaction.amount)}` : null,
    badge: null,
    link: {
      entity: "financialTransaction" as const,
      id: transaction.id,
      label: null,
    },
    disabledReason: null,
  };
};

/**
 * The transaction evidence behind a computed settlement. Evidence only: nothing here moves spend,
 * and the one verb opens a review that allocates only on an explicit, validated save.
 */
export const composeFinancialSettlementSection = (
  purchase: Pick<PurchaseOut, "id" | "financialReconciliation">,
  linked: readonly FinancialTransactionOut[],
) => {
  const settlement = purchase.financialReconciliation;
  return sectionOut({
    rows: [
      {
        label: "Status",
        value: {
          type: "pill",
          text: settlementLabel(settlement),
          color: optionColor(
            "purchase",
            "financialReconciliation",
            settlement.status,
          ),
        },
      },
      {
        label: "Posted",
        value: { type: "money", amount: settlement.postedTotal },
      },
      {
        label: "Projected",
        value: { type: "money", amount: settlement.projectedTotal },
      },
      ...(settlement.delta == null
        ? []
        : [
            {
              label: "Delta",
              value: { type: "money" as const, amount: settlement.delta },
            },
          ]),
    ],
    notes: [
      "Settlement amounts are evidence only. Expense lines remain Cubby's only source of spend.",
    ],
    items: linked.map((transaction) => linkedItem(purchase.id, transaction)),
    emptyText:
      "No linked transactions. Settlement evidence can remain unmatched until there is one truthful Purchase to link.",
    actions: [
      {
        id: "matchStatement",
        label: "Match statement activity",
        scope: "section",
        disabledReason: null,
      },
    ],
  });
};

export const purchaseFinancialSettlementReport = async (
  db: Database,
  id: string,
) => {
  const purchaseId = parseShortcodeFor("purchase", id);
  const purchase = await getPurchaseByShortcode(db, purchaseId);
  if (!purchase)
    throw createAppError("PURCHASE_NOT_FOUND", "Purchase not found");
  const linked = await listAll((pagination) =>
    listFinancialTransactions(
      db,
      { purchaseId },
      [{ orderBy: "postedDate", direction: "desc" }],
      pagination,
    ),
  );
  return sectionBlocks(
    composeFinancialSettlementSection(purchase, linked.data),
  );
};
