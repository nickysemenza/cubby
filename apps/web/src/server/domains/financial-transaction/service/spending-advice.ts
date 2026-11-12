import {
  financialSpendingAdvice,
  type FinancialSpendingAdvice,
} from "@cubby/schemas/financial-booking";
import { merchantIdentityProposal } from "@cubby/schemas/merchant-identity";
import type { StatementTransactionJudgment } from "@cubby/schemas/statement-suggestion";
import type { SupportedDecisionModel } from "@cubby/shared/ai/models";

import {
  type DecisionPort,
  runDecisionChoice,
  settleDecisionBranches,
} from "~/server/ai/decision-model";
import {
  suggestFields,
  type SuggestFieldsPorts,
} from "~/server/ai/field-suggest/suggest-fields";
import { type AiCallOwner } from "~/server/ai/policy/call-owner";
import {
  LOAN_ESCROW_DISBURSEMENT_FEATURE,
  MERCHANT_IDENTITY_FEATURE,
  MERCHANT_IDENTITY_SUPPORT_FEATURE,
} from "~/server/ai/policy/features";
import { runStructuredFeature } from "~/server/ai/run-feature";
import type { Database } from "~/server/db";

import {
  financialSpendingCategoryHistory,
  financialSpendingAccountIdentity,
  resolveFinancialSpendingVendors,
  type FinancialSpendingPage,
} from "../repo/financial-spending";

export type SpendingAdvicePort = (input: {
  judgment: StatementTransactionJudgment;
  owner: AiCallOwner;
}) => Promise<FinancialSpendingAdvice>;

export function needsSpendingAdvice(judgment: StatementTransactionJudgment) {
  return Boolean(
    judgment.create &&
    ["purchase", "refund", "fee"].includes(judgment.create.kind),
  );
}

/**
 * Advice has no write authority; every caller still uses the shared financial
 * planner. Questions that do not read each other's answers join one decision
 * wave: the loan-escrow question beside merchant identity, and identity support
 * beside the category question, which reads only the proposed name. A failure
 * surfaces in that order after both branches settle.
 */
export async function adviseSpending(
  db: Database,
  input: {
    judgment: StatementTransactionJudgment;
    owner: AiCallOwner;
    model?: SupportedDecisionModel;
    port?: DecisionPort;
    spendingAdvice?: SpendingAdvicePort;
    usageFor?: SuggestFieldsPorts["usageFor"];
    preparation?: Pick<
      FinancialSpendingPage,
      "accounts" | "categoryHistory" | "vendors"
    >;
  },
) {
  const create = input.judgment.create;
  if (!create || !needsSpendingAdvice(input.judgment)) return null;
  if (input.spendingAdvice)
    return financialSpendingAdvice.parse(await input.spendingAdvice(input));
  const account =
    input.preparation?.accounts.get(input.judgment.accountId) ??
    (await financialSpendingAccountIdentity(db, input.judgment.accountId));
  const escrow = async () => {
    if (
      account?.identity.kind !== "loan" ||
      create.kind !== "purchase" ||
      create.amount <= 0
    )
      return false;
    const feature = LOAN_ESCROW_DISBURSEMENT_FEATURE;
    const decision = await runDecisionChoice({
      feature,
      ...feature.prompt(
        JSON.stringify({
          merchant: create.merchant,
          description: create.rawDescription,
          sourceCategory: create.sourceCategory,
          amount: create.amount,
        }),
      ),
      choices: feature.choices,
      port: input.port,
      decisionModel: input.model,
      usage: {
        db,
        ...input.owner,
        operation: "spending.loanEscrowDisbursement",
      },
    });
    return decision.selectedIndex === 0 && decision.confidence === "high";
  };
  const merchant = create.merchant?.trim() || create.rawDescription?.trim();
  const advise = async (merchant: string) => {
    const [named] = await resolveFinancialSpendingVendors(
      db,
      [merchant],
      input.preparation,
    );
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
    const proposed = !named?.row && !named?.candidates.length && !input.port;
    if (proposed)
      identity = await runStructuredFeature(
        MERCHANT_IDENTITY_FEATURE,
        MERCHANT_IDENTITY_FEATURE.request(merchant, create.rawDescription),
        { db, ...input.owner, operation: "spending.merchantIdentity" },
      );
    const support = async () => {
      if (!proposed || !identity.name || identity.counterparty !== "business")
        return true;
      const validation = await runDecisionChoice({
        feature: MERCHANT_IDENTITY_SUPPORT_FEATURE,
        ...MERCHANT_IDENTITY_SUPPORT_FEATURE.prompt(
          JSON.stringify({
            merchant,
            description: create.rawDescription,
            proposed: identity.name,
          }),
        ),
        choices: MERCHANT_IDENTITY_SUPPORT_FEATURE.choices,
        decisionModel: input.model,
        usage: {
          db,
          ...input.owner,
          operation: "spending.merchantIdentitySupport",
        },
      });
      return validation.selectedIndex === 0 && validation.confidence === "high";
    };
    const category = async () => {
      let history: Awaited<
        ReturnType<typeof financialSpendingCategoryHistory>
      > = [];
      if (named?.row) {
        const lookup =
          input.preparation?.categoryHistory.get(named.row.id) ??
          financialSpendingCategoryHistory(db, named.row.id);
        input.preparation?.categoryHistory.set(named.row.id, lookup);
        history = await lookup;
      }
      const result = await suggestFields(
        db,
        input.owner,
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
        {
          decisionPort: input.port,
          decisionModel: input.model,
          usageFor: input.usageFor,
        },
      );
      return result.suggestions.spendingCategoryId;
    };
    const [supported, suggested] = await settleDecisionBranches(
      support,
      category,
    );
    if (!supported) identity.confidence = "low";
    return { identity, category: suggested };
  };
  const [escrowDisbursement, advised] = await settleDecisionBranches(
    escrow,
    async () => (merchant ? advise(merchant) : null),
  );
  if (!advised) return financialSpendingAdvice.parse({});
  const { identity, category } = advised;
  return financialSpendingAdvice.parse({
    ...(escrowDisbursement ? { escrowDisbursement: true } : {}),
    spendingCategoryId: category?.value ?? null,
    categoryConfidence: category?.confidence ?? "low",
    vendorName: identity.name,
    vendorConfidence: identity.confidence,
    counterparty: identity.counterparty,
  });
}
