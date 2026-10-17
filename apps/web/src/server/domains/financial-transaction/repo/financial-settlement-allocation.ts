import type { ActorContext } from "@cubby/schemas/context";
import type { FinancialSettlementAllocationInput } from "@cubby/schemas/financial-booking";
import { cents } from "@cubby/shared";
import { and, eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import {
  databaseForTransaction,
  notDeleted,
  withTransaction,
} from "~/server/db/helpers";
import {
  financialTransaction,
  financialTransactionAllocation,
  purchase,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

import {
  lockUpdatePurchases,
  updateFinancialTransaction,
} from "./financial-transaction";

const canonicalAllocations = (
  rows: readonly { purchaseId: string; amount: number }[],
) =>
  JSON.stringify(
    rows
      .map((row) => [row.purchaseId, cents(row.amount)])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
  );

/** Compare the exact graph displayed at selection under the ordinary writer's
 * locks. A stale proposal cannot discard a newly accepted split edge. */
export async function applyFinancialSettlementAllocation(
  db: Database,
  input: FinancialSettlementAllocationInput,
  actor: ActorContext,
) {
  return withTransaction(
    db,
    async (tx) => {
      const txDb = databaseForTransaction(tx);
      const id = await resolveOrThrow(
        txDb,
        "financialTransaction",
        input.transactionId,
      );
      await lockUpdatePurchases(tx, id, { allocations: input.allocations });
      await tx
        .select({ id: financialTransaction.id })
        .from(financialTransaction)
        .where(
          and(
            eq(financialTransaction.id, id),
            notDeleted(financialTransaction),
          ),
        )
        .for("update");
      const current = await tx
        .select({
          purchaseId: purchase.shortcode,
          amount: financialTransactionAllocation.amount,
        })
        .from(financialTransactionAllocation)
        .innerJoin(
          purchase,
          eq(purchase.id, financialTransactionAllocation.purchaseId),
        )
        .where(
          and(
            eq(financialTransactionAllocation.transactionId, id),
            notDeleted(financialTransactionAllocation),
          ),
        );
      if (
        canonicalAllocations(current) !==
        canonicalAllocations(input.priorAllocations)
      )
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          "Settlement allocations changed after this proposal. Review the current graph before saving; your draft has not been applied.",
        );
      await updateFinancialTransaction(
        txDb,
        input.transactionId,
        { allocations: input.allocations },
        actor,
      );
      return {
        transactionId: input.transactionId,
        allocations: input.allocations,
      };
    },
    { isolationLevel: "serializable" },
  );
}
