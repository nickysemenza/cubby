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
