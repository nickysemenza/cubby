import { z } from "zod";

/**
 * One completed model answer for one statement question. Reuse requires the
 * stored `input` to equal the question's current projected input (canonical
 * JSON) and `versions` to equal the current feature versions. A present answer
 * whose `value` is null is a completed abstention; an absent answer is
 * unanswered. Failures are never stored as answers.
 */
export const statementAnswer = <T extends z.ZodType>(value: T) =>
  z.object({
    value: value.nullable(),
    input: z.json(),
    versions: z.record(z.string(), z.string()),
    models: z.array(z.string()).default([]),
  });

export const statementEscrowAnswer = statementAnswer(z.boolean());
export type StatementEscrowAnswer = z.infer<typeof statementEscrowAnswer>;

/** Identity and support are separate questions; support depends on identity. */
export const statementMerchantAnswer = z.object({
  identity: statementAnswer(
    z.object({
      name: z.string().nullable(),
      counterparty: z.string(),
      confidence: z.string(),
    }),
  ),
  /** Null when support was inapplicable to the identity answer. */
  support: statementAnswer(z.boolean()).nullable(),
});
export type StatementMerchantAnswer = z.infer<typeof statementMerchantAnswer>;

/** Answers owned by spending advice; produced and validated by `adviseSpending`. */
export const statementSpendingAnswers = z.object({
  escrow: statementEscrowAnswer.optional(),
  merchant: statementMerchantAnswer.optional(),
});
export type StatementSpendingAnswers = z.infer<typeof statementSpendingAnswers>;

/**
 * Prompt versions of the spending questions. `ai/policy/features.ts` reads
 * these so repos can check answer validity without importing `ai/`.
 */
export const STATEMENT_ANSWER_VERSIONS = {
  escrow: "2026-11-12.1",
  merchantIdentity: "2026-11-13.1",
  merchantSupport: "2026-11-13.1",
} as const;

/** One merchant key for prompts, answer reuse and Vendor alias matching. */
export const statementMerchantKey = (merchant: string): string =>
  merchant.trim().replace(/\s+/g, " ").toLowerCase();

type SpendingSubject = {
  kind: string;
  merchant?: string | null;
  rawDescription?: string | null;
  sourceCategory?: string | null;
  amount: number;
};

/** Null when the escrow question does not apply. `amount` is the effective amount. */
export function statementEscrowInput(create: SpendingSubject, isLoan: boolean) {
  if (!isLoan || create.kind !== "purchase" || create.amount <= 0) return null;
  return {
    merchant: create.merchant ?? null,
    description: create.rawDescription ?? null,
    sourceCategory: create.sourceCategory ?? null,
    amount: create.amount,
  };
}

/** Null when there is no merchant text, so identity is inapplicable. */
export function statementMerchantIdentityInput(create: SpendingSubject) {
  const text = create.merchant?.trim() || create.rawDescription?.trim();
  const key = text ? statementMerchantKey(text) : "";
  return key ? { merchant: key } : null;
}

/** Support applies only to a proposed business name. */
export function statementMerchantSupportInput(
  identityInput: { merchant: string },
  identity: { name: string | null; counterparty: string },
) {
  if (!identity.name || identity.counterparty !== "business") return null;
  return { merchant: identityInput.merchant, proposed: identity.name };
}

type StatementAnswerInput = z.infer<ReturnType<typeof z.json>>;

const canonicalJson = (value: StatementAnswerInput): string =>
  JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : entry,
  );

/** A stored answer is reusable only for an equal input under equal versions. */
export function statementAnswerMatches(
  answer:
    | { input: StatementAnswerInput; versions: Record<string, string> }
    | undefined
    | null,
  input: StatementAnswerInput,
  versions: Record<string, string>,
): boolean {
  return Boolean(
    answer &&
    canonicalJson(answer.input) === canonicalJson(input) &&
    canonicalJson(answer.versions) === canonicalJson(versions),
  );
}

/** Advice fields carried by spending answers; Vendor resolution still wins. */
export function statementAdviceFromAnswers(answers: StatementSpendingAnswers) {
  const identity = answers.merchant?.identity.value ?? null;
  const supported = answers.merchant?.support?.value ?? true;
  return {
    ...(answers.escrow?.value === true ? { escrowDisbursement: true } : {}),
    vendorName: identity?.name ?? null,
    vendorConfidence: identity && supported ? identity.confidence : "low",
    counterparty: identity?.counterparty ?? "unknown",
  };
}

/** Keep only independently compatible spending answers from one retained row. */
export function reusableStatementSpendingAnswers(
  create: SpendingSubject,
  isLoan: boolean,
  answers: StatementSpendingAnswers,
): StatementSpendingAnswers {
  const result: StatementSpendingAnswers = {};
  const escrow = statementEscrowInput(create, isLoan);
  if (
    escrow &&
    statementAnswerMatches(answers.escrow, escrow, {
      "loan-escrow-disbursement": STATEMENT_ANSWER_VERSIONS.escrow,
    })
  )
    result.escrow = answers.escrow;
  const identityInput = statementMerchantIdentityInput(create);
  const merchant = answers.merchant;
  if (
    identityInput &&
    merchant &&
    statementAnswerMatches(merchant.identity, identityInput, {
      "merchant-identity": STATEMENT_ANSWER_VERSIONS.merchantIdentity,
    })
  ) {
    const supportInput = merchant.identity.value
      ? statementMerchantSupportInput(identityInput, merchant.identity.value)
      : null;
    result.merchant = {
      identity: merchant.identity,
      support:
        supportInput &&
        statementAnswerMatches(merchant.support, supportInput, {
          "merchant-identity-support":
            STATEMENT_ANSWER_VERSIONS.merchantSupport,
        })
          ? merchant.support
          : null,
    };
  }
  return result;
}

/** Absence means unanswered; completed negative and null answers are complete. */
export function statementSpendingAnswersComplete(
  create: SpendingSubject,
  isLoan: boolean,
  answers: StatementSpendingAnswers,
): boolean {
  if (!["purchase", "refund", "fee"].includes(create.kind)) return true;
  const reusable = reusableStatementSpendingAnswers(create, isLoan, answers);
  if (statementEscrowInput(create, isLoan) && !reusable.escrow) return false;
  const identityInput = statementMerchantIdentityInput(create);
  if (!identityInput) return true;
  const merchant = reusable.merchant;
  if (!merchant) return false;
  return (
    !merchant.identity.value ||
    !statementMerchantSupportInput(identityInput, merchant.identity.value) ||
    merchant.support !== null
  );
}
