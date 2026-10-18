import { financialTransactionKind } from "@cubby/schemas/financial-transaction";
import {
  statementCounterparty,
  type StatementTransactionJudgment,
} from "@cubby/schemas/statement-suggestion";
import type { SupportedDecisionModel } from "@cubby/shared/ai/models";

import {
  decisionChoiceFitsContext,
  type DecisionPort,
  runDecisionChoice,
} from "~/server/ai/decision-model";
import {
  STATEMENT_COUNTERPARTY_FEATURE,
  STATEMENT_TRANSACTION_KIND_FEATURE,
} from "~/server/ai/policy/features";
import { decideStatementKind } from "~/server/domains/statement-import/repo/statement-transaction-kind";

type Usage = Parameters<typeof runDecisionChoice>[0]["usage"];

/**
 * The decision model's two votes on a create — its kind, with the provider
 * category only a hint, and whether a person is on the other side — and the
 * kind they decide beside the rule and merchant history. Only a confident
 * answer votes; anything else abstains.
 */
export async function labelStatementKind(
  create: NonNullable<StatementTransactionJudgment["create"]>,
  context: {
    /** The statement row as the identity labels see it, JSON-encoded. */
    subject: string;
    transfer: StatementTransactionJudgment["transfer"];
    model: SupportedDecisionModel;
    port?: DecisionPort;
    usage: Usage;
  },
): Promise<NonNullable<StatementTransactionJudgment["create"]>> {
  const ask = async (
    feature:
      | typeof STATEMENT_TRANSACTION_KIND_FEATURE
      | typeof STATEMENT_COUNTERPARTY_FEATURE,
  ) => {
    const prompt = feature.prompt(context.subject);
    if (!decisionChoiceFitsContext(prompt)) return null;
    const result = await runDecisionChoice({
      ...prompt,
      feature,
      decisionModel: context.model,
      port: context.port,
      usage: context.usage,
    });
    const choice: string | undefined =
      feature.choices[result.selectedIndex ?? -1];
    return choice && result.confidence === "high" ? choice : null;
  };
  const kind = financialTransactionKind
    .nullable()
    .catch(null)
    .parse(await ask(STATEMENT_TRANSACTION_KIND_FEATURE));
  const counterparty = statementCounterparty.shape.label
    .catch(null)
    .parse(await ask(STATEMENT_COUNTERPARTY_FEATURE));
  return {
    ...create,
    ...decideStatementKind({
      amount: create.amount,
      votes: { ...create.votes, label: kind },
      counterparty: {
        ...create.counterparty,
        label: counterparty,
      },
      transfer: context.transfer,
    }),
  };
}
