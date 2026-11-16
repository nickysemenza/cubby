import { parseEntityId } from "@cubby/schemas/identifiers";
import type { ExtractedPurchaseLine } from "@cubby/schemas/purchase-import";
import { and, eq, isNull, sql } from "drizzle-orm";

import { notDeleted } from "~/server/db/helpers";
import { requested } from "~/server/db/helpers/requested";
import { expense } from "~/server/db/schema";
import { effectiveExpenseTradeSql } from "~/server/domains/expense/repo/expense-inheritance";

import type { LineIdentityDecision } from "./writer-decisions";

export function receiptProductQuantity(
  productId: string | null,
  line: ExtractedPurchaseLine,
  decision: Pick<LineIdentityDecision, "reversalKind">,
): number | null {
  if (!productId || line.quantity === undefined) return null;
  // An unpriced item line is an acquisition; only a printed negative reverses.
  if (line.amount === null || line.amount >= 0) return Math.abs(line.quantity);
  if (decision.reversalKind === "return") return -Math.abs(line.quantity);
  return decision.reversalKind === "concession" ? 0 : null;
}

export function planFallbackExpenses(expenseIds: readonly string[]) {
  const ids = requested(
    expenseIds.map((id) => ({
      entity: "expense",
      id: parseEntityId("expense", id),
    })),
  );
  return {
    where: and(
      ids.match({ entity: "expense", id: sql`${expense.id}` }),
      eq(expense.lineKind, "principal"),
      isNull(effectiveExpenseTradeSql()),
      notDeleted(expense),
    ),
  };
}
