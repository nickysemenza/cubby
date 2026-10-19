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
    // `interest` and `fee` are charges and must be positive: interest earned is
    // income, and a reversed fee is an adjustment (a refund is goods returned).
    interest: { kind: "interest", inflow: "income" },
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

const normalizeCategory = (category: string) =>
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
  /** Cubby convention: positive is money out of the account. */
  amount: number;
}): StatementTransactionKind {
  const direction = input.amount > 0 ? "outflow" : "inflow";
  const signKind: FinancialTransactionKind =
    direction === "outflow" ? "purchase" : "refund";
  if (!input.sourceCategory) return { kind: signKind, kindSource: "sign" };
  const rule = CATEGORY_RULES.get(normalizeCategory(input.sourceCategory));
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

/**
 * The kind a create records, from the sources' votes. An own-account move is
 * a transfer; a confident person label makes an outflow your share of a
 * shared cost (purchase) and an inflow a repayment (income); otherwise two
 * agreeing votes outrank the rule, which outranks the label.
 */
export function decideStatementKind(input: {
  /** Cubby convention: positive is money out of the account. */
  amount: number;
  votes: StatementKindVotes;
  counterparty: StatementCounterparty;
  transfer: StatementTransactionJudgment["transfer"];
}): KindDecision {
  const { votes, counterparty, transfer } = input;
  const decided = (
    kind: FinancialTransactionKind,
    kindSource: KindDecision["kindSource"],
  ): KindDecision => ({ kind, kindSource, votes, counterparty });
  if (transfer) return decided("account_transfer", "rule");
  if (counterparty.label === "person")
    return decided(input.amount > 0 ? "purchase" : "income", "model");
  // A kind the transaction schema refuses at this sign (an inflow as
  // `interest` or `fee`) is never proposed, and so never agreed.
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

/**
 * Whether a create's kind is bulk-acceptable: at least two sources name it and
 * none disagrees, nobody says the counterparty is a person, and the model has
 * said it is a business (history must, on a stored-value account) — or the
 * descriptor names one same-owner own account.
 */
export function kindAgreed(
  create: KindDecision,
  transfer: StatementTransactionJudgment["transfer"],
): boolean {
  const { votes, counterparty } = create;
  const cast = [votes.rule, votes.label, votes.history].filter(
    (vote) => vote !== null,
  );
  if (cast.length < 2 || cast.some((vote) => vote !== create.kind))
    return false;
  if (counterparty.label === "person" || counterparty.history === "person")
    return false;
  if (transfer) return transfer.accountId !== null && !transfer.ledgerTransfer;
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
