import { costTypeSchema } from "@cubby/schemas/expense-fields";
import type { ExpenseLineKind } from "@cubby/schemas/expense-line-kind";
import { tradeSchema } from "@cubby/schemas/task-fields";

import type { expense } from "~/server/db/retained-tables";
/** Reads: the replaced Expense notes/date/future/costType/trade/projectId/spendingCategoryId/bookingTransactionCode and accepted line title/seller/minor cost/role plus reviewed Product/quantity. */
export function replacementLineFields(input: {
  aggregate: Pick<
    typeof expense.$inferSelect,
    | "notes"
    | "date"
    | "future"
    | "costType"
    | "trade"
    | "projectId"
    | "spendingCategoryId"
    | "bookingTransactionCode"
  >;
  title: string;
  seller?: string;
  costMinor: bigint | null;
  lineKind: ExpenseLineKind;
}) {
  const { aggregate } = input;
  return {
    name: input.title,
    notes:
      [aggregate.notes, input.seller ? `Seller: ${input.seller}` : null]
        .filter(Boolean)
        .join("\n") || null,
    costMinor: input.costMinor,
    date: aggregate.date,
    future: aggregate.future,
    lineKind: input.lineKind,
    lineBasis: "item_line" as const,
    economicRole: "vendor" as const,
    costType: costTypeSchema.parse(aggregate.costType),
    trade: tradeSchema.nullable().parse(aggregate.trade),
    projectId: input.lineKind === "principal" ? aggregate.projectId : null,
    spendingCategoryId:
      input.lineKind === "principal" ? aggregate.spendingCategoryId : null,
    bookingTransactionCode: aggregate.bookingTransactionCode,
  };
}
