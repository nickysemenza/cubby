import type { ActorContext } from "@cubby/schemas/context";
import type { FinancialSettlementAllocationInput } from "@cubby/schemas/financial-booking";
import type { FinancialTransactionId } from "@cubby/schemas/identifiers";
import { cents } from "@cubby/shared";
import { and, eq, inArray } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
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
import { setDataException } from "~/server/generic/data-quality/repo/exceptions";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

import {
  lockUpdatePurchases,
  updateFinancialTransaction,
} from "./financial-transaction";
import { transactionSettlementConflicts } from "./settlement-conflicts";

/** Conflicts on purchases this proposal newly names, before the write. */
async function conflictsToAcknowledge(
  tx: DrizzleTransaction,
  transactionId: FinancialTransactionId,
  allocations: FinancialSettlementAllocationInput["allocations"],
  current: readonly { purchaseId: string }[],
) {
  const held = new Set(current.map((row) => row.purchaseId));
  const named = allocations
    .map((row) => row.purchaseId)
    .filter((code) => !held.has(code));
  if (named.length === 0) return [];
  const rows = await tx
    .select({ id: purchase.id, shortcode: purchase.shortcode })
    .from(purchase)
    .where(inArray(purchase.shortcode, named));
  const conflicts = await transactionSettlementConflicts(tx, {
    transactionId,
    purchaseIds: rows.map((row) => row.id),
  });
  return rows.flatMap((row) =>
    (conflicts.get(row.id) ?? []).map((kind) => ({
      purchaseCode: row.shortcode,
      kind,
    })),
  );
}

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
      const note = input.acknowledgeConflicts?.note;
      const acknowledged = note
        ? await conflictsToAcknowledge(tx, id, input.allocations, current)
        : [];
      await updateFinancialTransaction(
        txDb,
        input.transactionId,
        { allocations: input.allocations },
        actor,
        { acknowledgeSettlementConflicts: note !== undefined },
      );
      if (note)
        for (const { purchaseCode, kind } of acknowledged)
          await setDataException(
            txDb,
            {
              entityId: purchaseCode,
              check:
                kind === "party"
                  ? "settlement_party_conflict"
                  : "settlement_tender_conflict",
              reason:
                kind === "party" ? "confirmed_shared_use" : "confirmed_tender",
              note,
            },
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
