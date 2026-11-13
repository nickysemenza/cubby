import type { FinancialAccountIdentity } from "@cubby/schemas/financial-account-fields";
import {
  financialTransactionSettlementViolation,
  type FinancialTransactionKind,
} from "@cubby/schemas/financial-transaction";
import type {
  StatementCounterparty,
  StatementKindVotes,
  StatementTransactionJudgment,
} from "@cubby/schemas/statement-suggestion";

import { statementEffectiveMovement } from "~/server/domains/transaction-import/policy/statement-effective-movement";

type KindRule = {
  kind: FinancialTransactionKind;
  /** The category only implies this kind for money moving in this direction. */
  direction?: "inflow" | "outflow";
  /** The kind the category implies for money coming in, when that differs. */
  inflow?: FinancialTransactionKind;
};

/** A statement charge's kind and whether a rule chose it. */
export type StatementTransactionKind = {
  kind: FinancialTransactionKind;
  kindSource: "rule" | "sign";
};

/**
 * Provider categories that name a non-spending movement. Keys are normalized
 * (lowercase, `&`/`and` folded) so Monarch and Copilot spellings share a rule.
 */
const CATEGORY_RULES = new Map<string, KindRule>(
  Object.entries({
    paychecks: { kind: "income", direction: "inflow" },
    "other income": { kind: "income", direction: "inflow" },
    "business income": { kind: "income", direction: "inflow" },
    income: { kind: "income", direction: "inflow" },
    "dividends capital gains": { kind: "income", direction: "inflow" },
    // A reversed fee is an adjustment (a refund is goods returned).
    interest: { kind: "interest" },
    transfer: { kind: "account_transfer" },
    transfers: { kind: "account_transfer" },
    "internal transfer": { kind: "account_transfer" },
    "credit card payment": { kind: "credit_card_payment" },
    payment: { kind: "credit_card_payment" },
    payments: { kind: "credit_card_payment" },
    credit: { kind: "refund", direction: "inflow" },
    "balance adjustments": { kind: "adjustment" },
    "financial fees": { kind: "fee", inflow: "adjustment" },
    fees: { kind: "fee", inflow: "adjustment" },
  } satisfies Record<string, KindRule>),
);

export const foldProviderCategory = (category: string) =>
  category
    .normalize("NFKC")
    .toLowerCase()
    .replace(/&|\band\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * The kind a statement charge would be recorded as, and whether a rule chose
 * it. `sign` means no category spoke to it: only the amount's direction did,
 * so a model or member must label it before bulk acceptance.
 */
export function statementTransactionKind(input: {
  sourceCategory: string | null;
  accountKind?: FinancialAccountIdentity["kind"];
  rawDescription?: string | null;
  /** Cubby convention: positive is money out of the account. */
  amount: number;
}): StatementTransactionKind {
  const direction = input.amount > 0 ? "outflow" : "inflow";
  const signKind: FinancialTransactionKind =
    direction === "outflow" ? "purchase" : "refund";
  if (
    direction === "inflow" &&
    input.accountKind === "bank_account" &&
    /\binterest\b/i.test(input.rawDescription ?? "")
  )
    return { kind: "interest", kindSource: "rule" };
  if (!input.sourceCategory) return { kind: signKind, kindSource: "sign" };
  const rule = CATEGORY_RULES.get(foldProviderCategory(input.sourceCategory));
  if (rule && (!rule.direction || rule.direction === direction)) {
    const kind =
      direction === "inflow" && rule.inflow ? rule.inflow : rule.kind;
    // A rule never proposes a kind the transaction schema would refuse.
    if (
      !financialTransactionSettlementViolation({
        linked: false,
        kind,
        amount: input.amount,
      })
    )
      return { kind, kindSource: "rule" };
    return { kind: signKind, kindSource: "sign" };
  }
  if (rule) return { kind: signKind, kindSource: "sign" };
  // Any other category is read as spending, which settles an outflow as a
  // purchase. An inflow under one may still be a payment, transfer or income
  // the provider filed under a generic category, so it waits for a label.
  return {
    kind: signKind,
    kindSource: direction === "outflow" ? "rule" : "sign",
  };
}

type KindDecision = Pick<
  NonNullable<StatementTransactionJudgment["create"]>,
  "kind" | "kindSource" | "votes" | "counterparty"
>;

/** The statement text a counterparty rule reads. */
export type StatementDescriptor = Pick<
  NonNullable<StatementTransactionJudgment["create"]>,
  "rawDescription" | "merchant"
>;

/** The loan statement's payment entry records a balance movement. */
export function isLoanPayment(
  account: { kind: string },
  descriptor: StatementDescriptor,
): boolean {
  return (
    account.kind === "loan" &&
    statementEffectiveMovement({
      providerAmount: 1,
      description: descriptor.rawDescription,
      merchant: descriptor.merchant,
      sourceCategory: null,
      loan: { providerVendorNames: [], proven: true },
    }).movementClass === "loan_payment"
  );
}

/** Rails a person can pay or be paid through: payment apps and checks. */
const P2P_RAIL =
  / (venmo|zelle|cash ?app|square cash|paypal|apple cash|(check|chk) [0-9]+) /;

/**
 * Whether a person can be on the other side of a row: it is on a stored-value
 * (payment-app) account or its descriptor names a payment app or a check.
 * Cards and banks pay people only through such a rail; elsewhere a person-like
 * name is a seller, such as a Square or Shopify shop, or a bill naming the
 * member.
 */
export function statementP2PRail(
  descriptor: StatementDescriptor,
  counterparty: Pick<StatementCounterparty, "storedValue">,
) {
  return (
    counterparty.storedValue ||
    P2P_RAIL.test(
      words(`${descriptor.rawDescription ?? ""} ${descriptor.merchant ?? ""}`),
    )
  );
}

/**
 * The kind a create records, from the sources' votes. An own-account move is
 * a transfer; a confident person label makes an outflow your share of a
 * shared cost (purchase) and an inflow a repayment (income); otherwise two
 * agreeing votes outrank the rule, which outranks the label. Off a
 * peer-payment rail a person label or history reads as a business.
 */
export function decideStatementKind(input: {
  /** Cubby convention: positive is money out of the account. */
  amount: number;
  votes: StatementKindVotes;
  counterparty: StatementCounterparty;
  transfer: StatementTransactionJudgment["transfer"];
  descriptor: StatementDescriptor;
}): KindDecision {
  const { votes, transfer } = input;
  const counterparty: StatementCounterparty = statementP2PRail(
    input.descriptor,
    input.counterparty,
  )
    ? input.counterparty
    : {
        ...input.counterparty,
        label:
          input.counterparty.label === "person"
            ? "business"
            : input.counterparty.label,
        history:
          input.counterparty.history === "person"
            ? null
            : input.counterparty.history,
      };
  const decided = (
    kind: FinancialTransactionKind,
    kindSource: KindDecision["kindSource"],
  ): KindDecision => ({ kind, kindSource, votes, counterparty });
  if (transfer) return decided("account_transfer", "rule");
  if (counterparty.label === "person")
    return decided(input.amount > 0 ? "purchase" : "income", "model");
  // A kind the transaction schema refuses at this sign is never proposed.
  const cast = [votes.rule, votes.label, votes.history].filter(
    (vote): vote is FinancialTransactionKind =>
      vote !== null &&
      vote !== "mixed" &&
      !financialTransactionSettlementViolation({
        linked: false,
        kind: vote,
        amount: input.amount,
      }),
  );
  const majority = cast.find(
    (kind) => cast.filter((vote) => vote === kind).length >= 2,
  );
  if (majority)
    return decided(majority, votes.rule === majority ? "rule" : "model");
  if (votes.rule && cast.includes(votes.rule))
    return decided(votes.rule, "rule");
  if (votes.label && cast.includes(votes.label))
    return decided(votes.label, "model");
  return decided(input.amount > 0 ? "purchase" : "refund", "sign");
}

/** Kinds that move money between accounts rather than spend it. */
export const MONEY_MOVE_KINDS = [
  "account_transfer",
  "credit_card_payment",
] as const;
const MONEY_MOVES = new Set<KindDecision["kind"]>(MONEY_MOVE_KINDS);

export const isMoneyMoveKind = (kind: KindDecision["kind"]) =>
  MONEY_MOVES.has(kind);

/**
 * Spending needs agreeing evidence and a supported business counterparty.
 * An undisputed non-spending rule or confident label can record a standalone
 * transaction. A discovered pair must be clean; person-to-person rails and
 * cross-owner movements still require their own evidence and review.
 */
export function kindAgreed(
  create: KindDecision & Partial<StatementDescriptor>,
  /** The judgment's own-account move, stored or as listed. */
  transfer: Pick<
    NonNullable<StatementTransactionJudgment["transfer"]>,
    "ledgerTransfer"
  > | null,
  pair: Pick<
    NonNullable<StatementTransactionJudgment["transferPair"]>,
    "clean"
  > | null = null,
): boolean {
  const { votes, counterparty } = create;
  if (isMoneyMoveKind(create.kind)) {
    if (pair) return pair.clean;
    if (transfer?.ledgerTransfer) return false;
    if (
      create.rawDescription !== undefined &&
      statementP2PRail(
        {
          rawDescription: create.rawDescription,
          merchant: create.merchant ?? null,
        },
        counterparty,
      )
    )
      return false;
  } else if (transfer) return false;
  const cast = [votes.rule, votes.label, votes.history].filter(
    (vote) => vote !== null,
  );
  if (cast.some((vote) => vote !== create.kind)) return false;
  if (counterparty.label === "person" || counterparty.history === "person")
    return false;
  const nonSpending = [
    "interest",
    "income",
    "account_transfer",
    "credit_card_payment",
    "adjustment",
  ].includes(create.kind);
  if (
    nonSpending &&
    (votes.rule === create.kind || votes.label === create.kind) &&
    (counterparty.label === "business" || Boolean(transfer)) &&
    create.rawDescription !== undefined &&
    !statementP2PRail(
      {
        rawDescription: create.rawDescription,
        merchant: create.merchant ?? null,
      },
      counterparty,
    )
  )
    return true;
  if (cast.length < 2) return false;
  if (counterparty.storedValue) return counterparty.history === "business";
  return counterparty.label === "business";
}

export type OwnAccount = {
  id: string;
  kind: FinancialAccountIdentity["kind"];
  /** Provider, institution and provider-Vendor names a descriptor may use. */
  names: string[];
  ledgerPartyId: string | null;
};

/** Balance accounts money can be cashed out of or funded into. */
const BALANCE_KINDS = new Set<OwnAccount["kind"]>([
  "stored_value",
  "bank_account",
]);
/** Words a cash-out or funding descriptor uses; a payment to someone has none. */
const MOVE_WORDS =
  /\b(cash ?out|transfer|trnsfr|xfer|withdrawal|withdraw|add ?funds|top ?up|deposit)\b/;

const words = (text: string) =>
  ` ${text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()} `;

/**
 * The member's own balance account a cash-out or funding descriptor names,
 * when the charge's account and the named one are both balance accounts and
 * at least one holds stored value. Several fits prefer the charge account's
 * owner; a fit still ambiguous names no account.
 */
export function ownAccountNamed(
  descriptor: string,
  account: OwnAccount,
  accounts: readonly OwnAccount[],
): StatementTransactionJudgment["transfer"] {
  if (!BALANCE_KINDS.has(account.kind)) return null;
  const text = words(descriptor);
  if (!MOVE_WORDS.test(text)) return null;
  const named = accounts.filter(
    (other) =>
      other.id !== account.id &&
      BALANCE_KINDS.has(other.kind) &&
      (other.kind === "stored_value" || account.kind === "stored_value") &&
      other.names.some((name) => {
        const key = words(name);
        return key.trim().length >= 3 && text.includes(key);
      }),
  );
  if (!named.length) return null;
  const sameOwner = named.filter(
    (other) => other.ledgerPartyId === account.ledgerPartyId,
  );
  const [only] = sameOwner.length ? sameOwner : named;
  // Every fit belonging to another owner still owes a LedgerTransfer.
  if ((sameOwner.length || named.length) !== 1)
    return { accountId: null, ledgerTransfer: !sameOwner.length };
  return {
    accountId: only!.id,
    ledgerTransfer:
      only!.ledgerPartyId !== null &&
      account.ledgerPartyId !== null &&
      only!.ledgerPartyId !== account.ledgerPartyId,
  };
}
