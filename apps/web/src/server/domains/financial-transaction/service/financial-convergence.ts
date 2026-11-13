import type { ActorContext } from "@cubby/schemas/context";
import { financialConvergenceResult,type FinancialConvergenceInput } from "@cubby/schemas/financial-booking";
import { and,eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import { notDeleted } from "~/server/db/helpers";
import {repositoryQueries} from "~/server/db/repository-access.boundary";
import {expense,financialTransactionAllocation,purchase,sourceOrderObservation} from "~/server/db/schema";
import {settleOrderEvidence} from "~/server/domains/purchase-import/repo/settle-order-evidence";
import {resolveOrThrow} from "~/server/generic/shortcode/repo/shortcode-resolver";
import {reconcileNow} from "~/server/kernel/api";

/** Nudge the existing event owners; identity proof and conservation belong to them. */
export async function convergeFinancialEvidence(db: Database,input: FinancialConvergenceInput,_actor: ActorContext) {
  const q=repositoryQueries(db), id=await resolveOrThrow(db,"financialTransaction",input.transactionId);
  const observations=await q.select().from(sourceOrderObservation);
  await settleOrderEvidence(db,observations);
  const outcomes=await reconcileNow(db,[{kind:"purchaseEvent",key:id}]);
  const [saved]=await q.select({purchaseId:purchase.shortcode,expenseId:expense.shortcode}).from(financialTransactionAllocation)
    .innerJoin(purchase,eq(purchase.id,financialTransactionAllocation.purchaseId))
    .leftJoin(expense,and(eq(expense.purchaseId,purchase.id),notDeleted(expense)))
    .where(and(eq(financialTransactionAllocation.transactionId,id),notDeleted(financialTransactionAllocation),notDeleted(purchase)));
  return financialConvergenceResult.parse(saved?{status:"applied",...saved}:{status:"review_required",reason:outcomes.flatMap(row=>row.error ?? row.gaps.map(gap=>gap.input)).join("; ") || "Waiting for accepted evidence"});
}
