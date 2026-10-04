import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { PurchaseOut } from "@cubby/schemas/purchase";

import type { Database } from "~/server/db";
import { createAppError } from "~/server/errors/app-error";
import { reconciliationLabel } from "~/server/repo/list-display-labels";
import { getPurchaseByShortcode } from "~/server/repo/purchase";

import { optionColor, sectionBlocks, sectionOut } from "./finance-section";

/**
 * The sentence that keeps the cue from reading as a bug report. The verdict is the purchase's own
 * `reconciliation`, from `reconcilePurchase`, so the list column, this section and the
 * not-reconciling worklist cannot disagree.
 */
const NOTES = {
  unknown:
    "No stated total recorded yet — nothing to compare the expenses against. Add what the receipt or invoice says to turn this into a cue.",
  match:
    "The expenses add up to what the purchase stated. Stated totals are never summed into spend — spend is always the expenses.",
  refund_adjusted:
    "Posted refund evidence fully explains why the expenses are below the original stated total. The stated total remains the literal paperwork amount, and spend remains the expenses.",
  mismatch:
    "The expenses don't add up to what the purchase stated, and posted refund evidence doesn't fully explain the difference. Review the expenses, stated total, or settlement evidence.",
} satisfies Record<PurchaseOut["reconciliation"], string>;

/**
 * What the paperwork said against what the lines add up to. A stated total is a cue, never spend:
 * the two are compared, not reconciled into each other.
 */
export const composeReconciliationSection = (
  purchase: Pick<
    PurchaseOut,
    "statedTotal" | "expenseTotal" | "reconciliation"
  >,
) =>
  sectionOut({
    rows: [
      {
        label: "Stated",
        value: { type: "money", amount: purchase.statedTotal },
      },
      {
        label: "Expenses",
        value: { type: "money", amount: purchase.expenseTotal },
      },
      {
        label: "Verdict",
        value: {
          type: "pill",
          text: reconciliationLabel(purchase),
          color: optionColor(
            "purchase",
            "reconciliation",
            purchase.reconciliation,
          ),
        },
      },
    ],
    notes: [NOTES[purchase.reconciliation]],
    // Attaching changes what this comparison covers, so the verbs live here.
    actions: [
      {
        id: "linkExpenses",
        label: "Attach existing expenses",
        scope: "section",
        disabledReason: null,
      },
      {
        id: "linkProducts",
        label: "Attach products",
        scope: "section",
        disabledReason: null,
      },
    ],
  });

export const purchaseReconciliationReport = async (
  db: Database,
  id: string,
) => {
  const purchase = await getPurchaseByShortcode(
    db,
    parseShortcodeFor("purchase", id),
  );
  if (!purchase)
    throw createAppError("PURCHASE_NOT_FOUND", "Purchase not found");
  return sectionBlocks(composeReconciliationSection(purchase));
};
