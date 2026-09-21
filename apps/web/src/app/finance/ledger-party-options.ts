import { ledgerPartyKindValues } from "@cubby/schemas/ledger-party";

import { ledgerPartyLabel } from "~/app/_components/household-contribution-format";
import type { FilterableComboboxItem } from "~/components/ui/combobox";

/**
 * Labels for `LedgerParty.kind`, shared by the generic enum roster, the
 * contribution ledger, and the detail fact sheet. Wraps the canonical
 * `ledgerPartyLabel` (household-contribution ledger's own label) with the
 * roster shape `renderOptionCell` needs, rather than re-declaring the three
 * labels here.
 */
export const ledgerPartyKindOptions: FilterableComboboxItem[] =
  ledgerPartyKindValues.map((value) => ({
    value,
    label: ledgerPartyLabel(value),
    color: value === "household" ? "var(--primary)" : "var(--slate)",
  }));
