import { financialTransactionKind } from "./financial-transaction-fields";
import { z } from "zod";

export const statementQuestionSubject = z.object({
  descriptor: z.string().nullable(),
  merchant: z.string().nullable(),
  category: z.string().nullable(),
  date: z.string(),
  amount: z.number().finite(),
  status: z.enum(["pending", "posted"]).nullable(),
});

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

const statementKindVotes = z.object({
  /** The provider-category rule, or an own-account move the descriptor names. */
  rule: financialTransactionKind.nullable(),
  /** A high-confidence decision-model label. */
  label: financialTransactionKind.nullable(),
  /** Earlier member-made transactions on the account with the same merchant. */
  history: z.union([financialTransactionKind, z.literal("mixed")]).nullable(),
});
export type StatementKindVotes = z.infer<typeof statementKindVotes>;

const counterpartyKind = z.enum(["person", "business"]);
/** Who is on the other side; a person counterparty is never bulk-acceptable. */
const statementCounterparty = z.object({
  /** A high-confidence decision-model label. */
  label: counterpartyKind.nullable(),
  history: counterpartyKind.nullable(),
  /**
   * The charge's account holds stored value (a payment app). Its payees are
   * mostly people whose notes read like merchants, so only history, never the
   * label alone, establishes a business there.
   */
  storedValue: z.boolean().default(false),
});
export type StatementCounterparty = z.infer<typeof statementCounterparty>;
