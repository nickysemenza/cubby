import {
  financialSpendingAdvice,
  type FinancialSpendingAdvice,
} from "@cubby/schemas/financial-booking";
import type { RunId } from "@cubby/schemas/identifiers";
import { merchantIdentityProposal } from "@cubby/schemas/merchant-identity";
import type { StatementTransactionJudgment } from "@cubby/schemas/statement-suggestion";
import type { SupportedDecisionModel } from "@cubby/shared/ai/models";

import {
  type DecisionPort,
  runDecisionChoice,
} from "~/server/ai/decision-model";
import { suggestFields } from "~/server/ai/field-suggest/suggest-fields";
import {
  MERCHANT_IDENTITY_FEATURE,
  MERCHANT_IDENTITY_SUPPORT_FEATURE,
} from "~/server/ai/policy/features";
import { runStructuredFeature } from "~/server/ai/run-feature";
import type { Database } from "~/server/db";
import { resolveNames } from "~/server/entity-kernel/resolve";

import { financialSpendingCategoryHistory } from "../repo/financial-spending";

export type SpendingAdvicePort = (input: {
  judgment: StatementTransactionJudgment;
  runId: RunId;
}) => Promise<FinancialSpendingAdvice>;

export function needsSpendingAdvice(judgment: StatementTransactionJudgment) {
  return Boolean(
    judgment.create &&
    judgment.create.status !== "void" &&
    judgment.create.status !== "expected" &&
    ["purchase", "refund", "fee"].includes(judgment.create.kind),
  );
}

/** Advice has no write authority; every caller still uses the shared financial planner. */
export async function adviseSpending(
  db: Database,
  input: {
    judgment: StatementTransactionJudgment;
    runId: RunId;
    model?: SupportedDecisionModel;
    port?: DecisionPort;
    spendingAdvice?: SpendingAdvicePort;
  },
) {
  const create = input.judgment.create;
  if (!create || !needsSpendingAdvice(input.judgment)) return null;
  if (input.spendingAdvice)
    return financialSpendingAdvice.parse(await input.spendingAdvice(input));
  const merchant = create.merchant?.trim() || create.rawDescription?.trim();
  if (!merchant) return financialSpendingAdvice.parse({});
  const [named] = await resolveNames(db, "vendor", [{ name: merchant }], {
    create: false,
  });
  let identity = merchantIdentityProposal.parse({
    name: named?.row?.name ?? null,
    counterparty: "unknown",
    confidence: "low",
  });
  if (named?.row && !named.candidates.length)
    identity = {
      name: named.row.name,
      counterparty: "business",
      confidence: "high",
    };
  // A supplied decision port is a closed-set test/evaluation seam; it must
  // never fall through to a live generative request for an unknown merchant.
  if (!named?.row && !named?.candidates.length && !input.port) {
    identity = await runStructuredFeature(
      MERCHANT_IDENTITY_FEATURE,
      MERCHANT_IDENTITY_FEATURE.request(merchant, create.rawDescription),
      { db, runId: input.runId, operation: "spending.merchantIdentity" },
    );
    if (identity.name && identity.counterparty === "business") {
      const subject = JSON.stringify({
        merchant,
        description: create.rawDescription,
        proposed: identity.name,
      });
      const validation = await runDecisionChoice({
        feature: MERCHANT_IDENTITY_SUPPORT_FEATURE,
        ...MERCHANT_IDENTITY_SUPPORT_FEATURE.prompt(subject),
        choices: MERCHANT_IDENTITY_SUPPORT_FEATURE.choices,
        decisionModel: input.model,
        usage: {
          db,
          runId: input.runId,
          operation: "spending.merchantIdentitySupport",
        },
      });
      if (validation.selectedIndex !== 0 || validation.confidence !== "high")
        identity.confidence = "low";
    }
  }
  const history = named?.row
    ? await financialSpendingCategoryHistory(db, named.row.id)
    : [];
  const result = await suggestFields(
    db,
    input.runId,
    {
      entity: "expense",
      targets: ["spendingCategoryId"],
      basisMode: "provided",
      basis: {
        name: merchant,
        vendor: identity.name ?? merchant,
        lineKind: "principal",
        notes: JSON.stringify({
          description: create.rawDescription,
          amount: create.amount,
          kind: create.kind,
          providerCategory: create.sourceCategory,
          kindVotes: create.votes,
          categoryHistory: history,
        }),
      },
    },
    { decisionPort: input.port, decisionModel: input.model },
  );
  const category = result.suggestions.spendingCategoryId;
  return financialSpendingAdvice.parse({
    spendingCategoryId: category?.value ?? null,
    categoryConfidence: category?.confidence ?? "low",
    vendorName: identity.name,
    vendorConfidence: identity.confidence,
    counterparty: identity.counterparty,
  });
}
