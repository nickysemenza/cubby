import type { FinancialAccountIdentityKind } from "@cubby/schemas/financial-account";
import { financialAccountIdentityKind } from "@cubby/schemas/financial-account";
import type { FilterableComboboxItem } from "~/components/ui/combobox";

/**
 * Labels for `FinancialAccount.provisional`, shared by the list column and the
 * detail fact sheet.
 *
 * One roster because the two surfaces had drifted: the list rendered
 * `Provisional` / `Known` chips while the detail page said `Yes` / `No` for the
 * same field, so the same account read as two different facts depending on where
 * you looked. `provisional` is `NOT NULL`, so both states are always known.
 */
export const provisionalOptions: FilterableComboboxItem[] = [
  { value: "true", label: "Provisional", color: "var(--warning)" },
  { value: "false", label: "Known", color: "var(--positive)" },
];

const ACCOUNT_IDENTITY_KIND_LABELS: Record<
  FinancialAccountIdentityKind,
  string
> = {
  credit_card: "Credit card",
  bank_account: "Bank account",
  stored_value: "Gift card or store credit",
  cash: "Cash",
  other: "Other",
};

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
