import {
  financialTransactionSettlementViolation,
  type FinancialTransactionKind,
} from "@cubby/schemas/financial-transaction";

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
