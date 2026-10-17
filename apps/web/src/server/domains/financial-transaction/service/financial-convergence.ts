import type { ActorContext } from "@cubby/schemas/context";
import type { FinancialConvergenceInput } from "@cubby/schemas/financial-booking";

import type { Database } from "~/server/db";
import {
  convergeFinancialTransaction,
  resolveConvergenceEmail,
} from "~/server/domains/financial-transaction/repo/financial-convergence";
import { prepareMailFinancialEvent } from "~/server/domains/purchase-import/service/mail-financial-event";

export async function convergeFinancialEvidence(
  db: Database,
  input: FinancialConvergenceInput,
  actor: ActorContext,
) {
  if (!input.emailId) return convergeFinancialTransaction(db, input, actor);
  const emailId = await resolveConvergenceEmail(db, input.emailId);
  const prepared = await prepareMailFinancialEvent(db, { emailId }, actor);
  if (prepared.status !== "verified")
    return { status: "review_required" as const, reason: prepared.reason };
  return convergeFinancialTransaction(db, input, actor, prepared.preparation);
}
