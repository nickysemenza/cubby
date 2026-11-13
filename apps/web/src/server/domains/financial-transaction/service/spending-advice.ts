import { actorInRun, systemActor } from "@cubby/schemas/context";
import {
  financialSpendingAdvice,
  type FinancialSpendingAdvice,
} from "@cubby/schemas/financial-booking";
import {
  reusableStatementSpendingAnswers,
  STATEMENT_ANSWER_VERSIONS,
  statementAdviceFromAnswers,
  statementEscrowInput,
  statementMerchantIdentityInput,
  statementMerchantSupportInput,
  type StatementSpendingAnswers,
} from "@cubby/schemas/statement-answers";
import type { StatementTransactionJudgment } from "@cubby/schemas/statement-suggestion";
import type { SupportedDecisionModel } from "@cubby/shared/ai/models";

import {
  type DecisionChoiceArgs,
  decisionModelFor,
  type DecisionPort,
  runDecisionChoice,
  settleDecisionBranches,
} from "~/server/ai/decision-model";
import { preparingAiInputs } from "~/server/ai/evaluation-inputs";
import { type AiCallOwner } from "~/server/ai/policy/call-owner";
import {
  LOAN_ESCROW_DISBURSEMENT_FEATURE,
  MERCHANT_IDENTITY_FEATURE,
  MERCHANT_IDENTITY_SUPPORT_FEATURE,
} from "~/server/ai/policy/features";
import { runStructuredFeature } from "~/server/ai/run-feature";
import type { Database } from "~/server/db";
import { aliasStatementMerchant } from "~/server/domains/vendor/repo/statement-merchant-alias";
import { buildCrudServices } from "~/server/http/request-context";

import {
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

/** A completed closed-set answer: the first choice at high confidence. */
async function askChoice(args: DecisionChoiceArgs) {
  const decision = await runDecisionChoice(args);
  return {
    value: decision.selectedIndex === 0 && decision.confidence === "high",
    models: [decisionModelFor(args)],
  };
}

/**
 * Advice has no write authority; every caller still uses the shared financial
 * planner. Passed answers whose inputs and versions are current are reused;
 * only missing questions are asked, and every completed answer is returned
 * for the caller to store. The escrow question joins merchant identity's
 * decision wave; support reads identity's proposed name. A failure surfaces in
 * that order after both branches settle. A merchant naming exactly one live
 * Vendor asks no merchant question; any other Vendor match keeps today's
 * low-confidence advice. A supported business answer may alias an unknown raw
 * merchant onto the one Vendor it names.
 */
export async function adviseSpending(
  db: Database,
  input: {
    judgment: StatementTransactionJudgment;
    owner: AiCallOwner;
    answers?: StatementSpendingAnswers;
    model?: SupportedDecisionModel;
    port?: DecisionPort;
    spendingAdvice?: SpendingAdvicePort;
    preparation?: Pick<FinancialSpendingPage, "accounts" | "vendors">;
  },
): Promise<{
  advice: FinancialSpendingAdvice;
  answers: StatementSpendingAnswers;
} | null> {
  const create = input.judgment.create;
  if (!create || !needsSpendingAdvice(input.judgment)) return null;
  if (input.spendingAdvice)
    return {
      advice: financialSpendingAdvice.parse(await input.spendingAdvice(input)),
      answers: input.answers ?? {},
    };
  const account =
    input.preparation?.accounts.get(input.judgment.accountId) ??
    (await financialSpendingAccountIdentity(db, input.judgment.accountId));
  const isLoan = account?.identity.kind === "loan";
  const answers = reusableStatementSpendingAnswers(
    create,
    isLoan,
    input.answers ?? {},
  );
  const escrowInput = statementEscrowInput(create, isLoan);
  const identityInput = statementMerchantIdentityInput(create);
  const merchantText = create.merchant?.trim() || create.rawDescription?.trim();

  const escrow = async () => {
    if (!escrowInput || answers.escrow) return;
    const feature = LOAN_ESCROW_DISBURSEMENT_FEATURE;
    answers.escrow = {
      ...(await askChoice({
        feature,
        ...feature.prompt(JSON.stringify(escrowInput)),
        choices: feature.choices,
        port: input.port,
        decisionModel: input.model,
        usage: {
          db,
          ...input.owner,
          operation: "spending.loanEscrowDisbursement",
        },
      })),
      input: escrowInput,
      versions: { [feature.feature]: STATEMENT_ANSWER_VERSIONS.escrow },
    };
  };
  const merchant = async () => {
    if (!merchantText || !identityInput) return;
    const [named] = await resolveFinancialSpendingVendors(
      db,
      [merchantText],
      input.preparation,
    );
    // One live Vendor identifies the merchant; its questions are inapplicable.
    if (named?.row && !named.candidates.length) {
      delete answers.merchant;
      return named;
    }
    // A supplied decision port is a closed-set test/evaluation seam; it must
    // never fall through to a live generative request.
    if (!answers.merchant && !input.port)
      answers.merchant = {
        identity: {
          value: await runStructuredFeature(
            MERCHANT_IDENTITY_FEATURE,
            MERCHANT_IDENTITY_FEATURE.request(identityInput),
            { db, ...input.owner, operation: "spending.merchantIdentity" },
          ),
          input: identityInput,
          versions: {
            [MERCHANT_IDENTITY_FEATURE.feature]:
              STATEMENT_ANSWER_VERSIONS.merchantIdentity,
          },
          models: [MERCHANT_IDENTITY_FEATURE.model],
        },
        support: null,
      };
    const identity = answers.merchant?.identity.value;
    const supportInput =
      identity && statementMerchantSupportInput(identityInput, identity);
    if (!answers.merchant || !supportInput || answers.merchant.support)
      return named;
    const feature = MERCHANT_IDENTITY_SUPPORT_FEATURE;
    answers.merchant.support = {
      ...(await askChoice({
        feature,
        ...feature.prompt(JSON.stringify(supportInput)),
        choices: feature.choices,
        port: input.port,
        decisionModel: input.model,
        usage: {
          db,
          ...input.owner,
          operation: "spending.merchantIdentitySupport",
        },
      })),
      input: supportInput,
      versions: {
        [feature.feature]: STATEMENT_ANSWER_VERSIONS.merchantSupport,
      },
    };
    return named;
  };
  const [, named] = await settleDecisionBranches(escrow, merchant);

  const answered = statementAdviceFromAnswers(answers);
  const advice = financialSpendingAdvice.parse(
    named?.row || named?.candidates.length
      ? {
          escrowDisbursement: answered.escrowDisbursement,
          vendorName: named.row?.name ?? null,
          ...(named.row &&
            !named.candidates.length && {
              vendorConfidence: "high",
              counterparty: "business",
            }),
        }
      : answered,
  );
  if (merchantText && !named?.row && !named?.candidates.length)
    await aliasSupportedMerchant(db, {
      judgment: input.judgment,
      owner: input.owner,
      answers,
      merchant: merchantText,
      preparation: input.preparation,
    });
  return { advice, answers };
}

/**
 * The new-Vendor bar (a supported, high-confidence business) also adds an
 * unknown raw merchant as an alias of the one existing Vendor it names. New
 * Vendors are created only at first booking. Person and payment-app evidence
 * vetoes aliasing even when the model proposed a business.
 */
async function aliasSupportedMerchant(
  db: Database,
  input: {
    judgment: StatementTransactionJudgment;
    owner: AiCallOwner;
    answers: StatementSpendingAnswers;
    merchant: string;
    preparation?: Pick<FinancialSpendingPage, "vendors">;
  },
) {
  const create = input.judgment.create!;
  const identity = input.answers.merchant?.identity.value;
  if (
    preparingAiInputs() ||
    !["purchase", "refund"].includes(create.kind) ||
    create.counterparty.storedValue ||
    create.counterparty.label === "person" ||
    create.counterparty.history === "person" ||
    !identity?.name ||
    identity.counterparty !== "business" ||
    identity.confidence !== "high" ||
    input.answers.merchant?.support?.value !== true
  )
    return;
  // Skip the write transaction unless the name already resolves uniquely.
  const [target] = await resolveFinancialSpendingVendors(
    db,
    [identity.name],
    input.preparation,
  );
  if (!target?.row || target.candidates.length) return;
  await aliasStatementMerchant(db, {
    merchant: input.merchant,
    vendorName: identity.name,
    actor: input.owner.runId
      ? actorInRun(systemActor(), input.owner.runId)
      : systemActor(),
    servicesFor: buildCrudServices,
  });
}
