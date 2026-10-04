import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { RelatedSummaryOutput } from "@cubby/schemas/related-view";

import { formatCurrency } from "~/lib/utils";
import type { Database } from "~/server/db";
import { createAppError } from "~/server/errors/app-error";
import { getPurchaseByShortcode } from "~/server/repo/purchase";
import { loadRelatedSummary } from "~/server/repo/related-view";

import { sectionBlocks, sectionOut } from "./finance-section";

/** Every project group a purchase can spread over fits one read. */
const MAX_PROJECT_GROUPS = 100;

/**
 * Spend on this purchase's lines, rolled up by the project they belong to. Tax, shipping, fees and
 * discounts follow the item project shares, so the groups add up to the purchase's expense total
 * (`SUM(Expense.cost)`); the figures here are that same total attributed, never a second source of
 * spend. Reading only: moving a line to another project is an Expense edit.
 */
const composeProjectAllocationSection = (
  expenseTotal: number,
  summary: RelatedSummaryOutput,
) => {
  const { totals } = summary;
  return sectionOut({
    rows: [
      {
        label: "Items + shared charges",
        value: { type: "money", amount: expenseTotal },
      },
    ],
    notes: [
      "Tax, shipping, fees, and discounts follow the purchase’s item project shares. The project totals below add up to this expense total.",
    ],
    items: summary.data.map((group) => ({
      id: group.target?.id ?? "unassigned",
      title: group.target?.label ?? "Unassigned",
      lines: [
        `${formatCurrency(group.itemSpend)} items + ${formatCurrency(group.sharedChargeSpend)} shared`,
        group.incomplete ? "Incomplete coverage" : "Complete coverage",
      ],
      amount: group.netSpend,
      amountNote: null,
      badge: null,
      link:
        group.target?.entity === "project"
          ? { entity: "project" as const, id: group.target.id, label: null }
          : null,
      disabledReason: null,
    })),
    emptyText: "No item or shared-charge allocation is available yet.",
    footer:
      summary.data.length === 0
        ? null
        : `${summary.count} ${summary.count === 1 ? "group" : "groups"} · ${formatCurrency(totals.itemSpend)} items + ${formatCurrency(totals.sharedChargeSpend)} shared = ${formatCurrency(totals.netSpend)} total${
            totals.incomplete ? " · incomplete coverage" : ""
          }${
            totals.unpricedExpenseCount > 0
              ? ` · ${totals.unpricedExpenseCount} unpriced`
              : ""
          }`,
  });
};

export const purchaseProjectAllocationReport = async (
  db: Database,
  id: string,
) => {
  const purchaseId = parseShortcodeFor("purchase", id);
  const purchase = await getPurchaseByShortcode(db, purchaseId);
  if (!purchase)
    throw createAppError("PURCHASE_NOT_FOUND", "Purchase not found");
  return sectionBlocks(
    composeProjectAllocationSection(
      purchase.expenseTotal,
      await loadRelatedSummary(db, {
        relationKey: "purchase.projects",
        sourceId: purchaseId,
        sort: { field: "netSpend", direction: "desc" },
        offset: 0,
        limit: MAX_PROJECT_GROUPS,
      }),
    ),
  );
};
