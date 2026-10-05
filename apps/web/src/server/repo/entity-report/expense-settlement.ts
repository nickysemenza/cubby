import { expenseShortcode } from "@cubby/schemas/identifiers";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { ExpenseOut } from "@cubby/schemas/project";
import { SPLIT_NEEDS_PURCHASE_REASON } from "@cubby/schemas/purchase";

import { formatCalendarDay } from "~/lib/date-format";
import { purchaseLabel } from "~/lib/purchase-label";
import { formatCurrency } from "~/lib/utils";
import type { Database } from "~/server/db";
import { createAppError } from "~/server/errors/app-error";
import { expenseChargeContextWorkflow } from "~/server/operations/expense.server";
import { getExpenseByShortcode } from "~/server/repo/expense/crud";
import { cents } from "~/server/repo/money";

import { sectionBlocks, sectionOut } from "./finance-section";

type ChargeContext = Awaited<ReturnType<typeof expenseChargeContextWorkflow>>;

const countLabel = (count: number) =>
  `${count} expense${count === 1 ? "" : "s"}`;

/**
 * How this line settles: the purchase it belongs to and its sibling lines (the whole purchase,
 * this line included, so the total reconciles against a receipt), plus the verbs that act on the
 * line. Receiving is a deliberate, separate act — linking a product records what was bought and
 * never moves inventory on its own.
 */
export const composeExpenseSettlementSection = (
  expense: Pick<ExpenseOut, "cost" | "purchaseId" | "productId">,
  context: ChargeContext,
) => {
  const actions = [
    {
      id: "splitExpense" as const,
      label: "Split",
      scope: "section" as const,
      disabledReason: expense.purchaseId ? null : SPLIT_NEEDS_PURCHASE_REASON,
    },
    {
      id: "receiveExpense" as const,
      label: "Receive",
      scope: "section" as const,
      disabledReason: expense.productId
        ? null
        : "Link a product first — receiving needs something to put on a shelf.",
    },
  ];
  if (!expense.purchaseId || !context)
    return sectionOut({
      items: [],
      emptyText:
        "No purchase recorded — this line stands alone until a vendor order claims it.",
      actions,
    });

  const { purchase, siblings } = context;
  const lines = [expense, ...siblings];
  const priced = lines.filter((line) => line.cost !== null);
  // Called out rather than folded in as zero: a purchase that does not reconcile because a line
  // has no cost recorded is a different problem from one whose price is wrong.
  const unpriced = lines.length - priced.length;
  const totalCents = priced.reduce(
    (sum, line) => sum + cents(line.cost ?? 0),
    0,
  );
  return sectionOut({
    items: [
      {
        id: purchase.id,
        title: purchaseLabel(purchase),
        lines: [],
        amount: null,
        amountNote: null,
        badge: "Purchase",
        link: { entity: "purchase", id: purchase.id, label: null },
        disabledReason: null,
      },
      ...siblings.map((line) => ({
        id: line.id,
        title: line.name,
        lines: line.date ? [formatCalendarDay(line.date, "dateShort")] : [],
        amount: line.cost,
        amountNote: null,
        badge: null,
        link: { entity: "expense" as const, id: line.id, label: null },
        disabledReason: null,
      })),
    ],
    notes:
      siblings.length === 0
        ? ["This is the only expense in the purchase."]
        : [],
    footer: `${countLabel(lines.length)} · ${formatCurrency(totalCents / 100)}${
      unpriced > 0 ? ` · ${unpriced} without a cost` : ""
    }`,
    actions,
  });
};

export const expenseSettlementReport = async (db: Database, id: string) => {
  const expenseId = parseShortcodeFor("expense", id);
  const expense = await getExpenseByShortcode(db, expenseId);
  if (!expense) throw createAppError("EXPENSE_NOT_FOUND", "Expense not found");
  return sectionBlocks(
    composeExpenseSettlementSection(
      expense,
      expense.purchaseId
        ? await expenseChargeContextWorkflow(
            db,
            expenseShortcode.parse(expense.id),
          )
        : null,
    ),
  );
};
