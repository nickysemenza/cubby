import type {
  FinancialTransactionKind,
  FinancialTransactionStatus,
} from "@cubby/schemas/financial-transaction";
import {
  financialTransactionKind,
  financialTransactionStatus,
} from "@cubby/schemas/financial-transaction";

import { type BadgeVariant, badgeVariantColor } from "~/components/ui/badge";
import type { FilterableComboboxItem } from "~/components/ui/combobox";

const KIND_LABELS: Record<FinancialTransactionKind, string> = {
  purchase: "Purchase",
  refund: "Refund",
  account_transfer: "Account transfer",
  credit_card_payment: "Card payment",
  fee: "Fee",
  interest: "Interest",
  income: "Income",
  adjustment: "Adjustment",
  other: "Other",
};

/**
 * Labels and tone for `FinancialTransaction.kind`.
 *
 * The column was a `createTextColumn`, so it printed the raw enum —
 * `credit_card_payment`, `account_transfer` — straight from the database. Tone
 * follows the money direction the schema already documents: inflows (`refund`,
 * `income`) read positive, movement between our own accounts stays neutral.
 */
const KIND_TONE: Record<FinancialTransactionKind, BadgeVariant> = {
  purchase: "default",
  refund: "positive",
  income: "positive",
  account_transfer: "slate",
  credit_card_payment: "slate",
  fee: "warning",
  interest: "warning",
  adjustment: "secondary",
  other: "outline",
};

export const financialTransactionKindOptions: FilterableComboboxItem[] =
  financialTransactionKind.options.map((value) => ({
    value,
    label: KIND_LABELS[value],
    color: badgeVariantColor[KIND_TONE[value]],
  }));

const STATUS_LABELS: Record<FinancialTransactionStatus, string> = {
  expected: "Expected",
  pending: "Pending",
  posted: "Posted",
  void: "Void",
};

/**
 * Labels and tone for `FinancialTransaction.status`.
 *
 * `posted` is the healthy terminal state and reads positive; `expected` and
 * `pending` are in-flight rather than wrong, so they stay neutral, and only
 * `void` is tinted as a problem.
 */
const STATUS_TONE: Record<FinancialTransactionStatus, BadgeVariant> = {
  expected: "outline",
  pending: "slate",
  posted: "positive",
  void: "destructive",
};

export const financialTransactionStatusOptions: FilterableComboboxItem[] =
  financialTransactionStatus.options.map((value) => ({
    value,
    label: STATUS_LABELS[value],
    color: badgeVariantColor[STATUS_TONE[value]],
  }));
