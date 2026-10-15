import type { ActorContext } from "@cubby/schemas/context";
import type { ExpenseLineKind } from "@cubby/schemas/expense-line-kind";
import type { ExpenseCreateInput } from "@cubby/schemas/project";

import type { Database } from "~/server/db";

export type ExpenseLineRoleEvidence = Pick<
  ExpenseCreateInput,
  "name" | "cost" | "notes"
>;

/**
 * The Expense line-role Decision, supplied by the caller
 * (`service/expense-line-role`): an Expense write that must classify a line
 * asks it before its transaction, and the repo never calls the model itself.
 */
export type ExpenseLineRoleClassifier = (
  db: Database,
  actor: ActorContext,
  evidence: ExpenseLineRoleEvidence,
) => Promise<ExpenseLineKind>;

export const requireLineRoleClassifier = (
  classify: ExpenseLineRoleClassifier | undefined,
): ExpenseLineRoleClassifier => {
  if (!classify)
    throw new Error(
      "This Expense line has no role and no line-role classifier was supplied",
    );
  return classify;
};
