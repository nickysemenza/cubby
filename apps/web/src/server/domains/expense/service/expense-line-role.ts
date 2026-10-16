import type { ActorContext } from "@cubby/schemas/context";
import type { ExpenseLineKind } from "@cubby/schemas/expense-line-kind";
import { expenseLineKindValues } from "@cubby/schemas/expense-line-kind";

import {
  type DecisionChoiceResult,
  type DecisionPort,
  decisionChoiceFitsContext,
  runDecisionChoice,
} from "~/server/ai/decision-model";
import { PURCHASE_IMPORT_EXPENSE_LINE_ROLE_FEATURE } from "~/server/ai/policy/features";
import { expenseLineRoleRules } from "~/server/ai/policy/prompts/purchase-lines";
import type { AiRunContext } from "~/server/ai/run-feature";
import type { Database } from "~/server/db";
import type {
  ExpenseLineRoleClassifier,
  ExpenseLineRoleEvidence,
} from "~/server/domains/expense/repo/line-role-classifier";
import {
  aiCallRunInput,
  ensureRun,
} from "~/server/domains/run/repo/ensure-run";

const roleChoices = expenseLineKindValues.filter(
  (lineKind): lineKind is Exclude<ExpenseLineKind, "unclassified"> =>
    lineKind !== "unclassified",
);

/** The calibrated decision must be concrete and high confidence to persist. */
export function acceptExpenseLineRole(
  result: DecisionChoiceResult,
): ExpenseLineKind {
  if (result.confidence !== "high" || result.selectedIndex === null) {
    return "unclassified";
  }
  return roleChoices[result.selectedIndex] ?? "unclassified";
}

type RoleEvidence = ExpenseLineRoleEvidence;

/**
 * Ask the existing Expense line-role Decision before a business transaction.
 * The Run is committed first so every usage row refers to durable ownership.
 */
async function classifyExpenseLineRole(
  db: Database,
  actor: ActorContext,
  evidence: RoleEvidence,
  port?: DecisionPort,
): Promise<ExpenseLineKind> {
  const runId = await ensureRun(db, actor, aiCallRunInput(actor));
  return decideExpenseLineRole(
    evidence,
    {
      db,
      runId,
      operation: "expense.create.line-role",
    },
    port,
  );
}

/** The classifier Expense writes take; `port` replaces only the decision provider. */
export const expenseLineRoleClassifier =
  (port?: DecisionPort): ExpenseLineRoleClassifier =>
  (db, actor, evidence) =>
    classifyExpenseLineRole(db, actor, evidence, port);

/** Shared call seam lets tests replace only the decision provider. */
export async function decideExpenseLineRole(
  evidence: RoleEvidence,
  usage: AiRunContext,
  port?: DecisionPort,
): Promise<ExpenseLineKind> {
  const subject = JSON.stringify({
    name: evidence.name,
    amount: evidence.cost,
    notes: evidence.notes,
  });
  const rules = expenseLineRoleRules;
  const prompt = { subject, rules, choices: roleChoices, allowNone: true };
  if (!decisionChoiceFitsContext(prompt)) {
    throw new Error(
      "Expense receipt-role evidence exceeds the decision context bound.",
    );
  }
  const result = await runDecisionChoice({
    feature: PURCHASE_IMPORT_EXPENSE_LINE_ROLE_FEATURE,
    ...prompt,
    usage,
    port,
  });
  return acceptExpenseLineRole(result);
}
