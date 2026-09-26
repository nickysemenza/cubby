import type { FinancialAccountIdentityKind } from "@cubby/schemas/financial-account";
import { financialAccountIdentityKind } from "@cubby/schemas/financial-account";

import type { FilterableComboboxItem } from "~/components/ui/combobox";

const ACCOUNT_IDENTITY_KIND_LABELS = {
  credit_card: "Credit card",
  bank_account: "Bank account",
  stored_value: "Gift card or store credit",
  cash: "Cash",
  other: "Other",
} satisfies Record<FinancialAccountIdentityKind, string>;

/**
 * Labels and tone for `FinancialAccount.identity.kind`.
 *
 * The list column used to render `kind.replaceAll("_", " ")`, which turns
 * `stored_value` into "stored value" — readable, but a transform is not a label,
 * and the detail page ran the same `replaceAll` independently. Naming the five
 * kinds once means "Gift card / store credit" can say more than the enum
 * literal can.
 */
export const accountIdentityKindOptions: FilterableComboboxItem[] =
  financialAccountIdentityKind.options.map((value) => ({
    value,
    label: ACCOUNT_IDENTITY_KIND_LABELS[value],
    color: "var(--slate)",
  }));
