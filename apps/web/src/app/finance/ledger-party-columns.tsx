import { ledgerPartyKindValues } from "@cubby/schemas/ledger-party";
import type { LedgerPartyOut } from "@cubby/schemas/ledger-party";

import { renderOptionCell } from "~/app/_components/data-table/columnHelpers";
import type { CubbyColumnHelper } from "~/app/_components/data-table/table-features";
import { ledgerPartyLabel } from "~/app/_components/household-contribution-format";
import { TableLink } from "~/app/_components/table/TableLink";
import type { FilterableComboboxItem } from "~/components/ui/combobox";
import { entities, entityDetailParams } from "~/entities/entities";

/**
 * Labels for `LedgerParty.kind`, shared by the list column and the detail
 * fact sheet. Wraps the canonical `ledgerPartyLabel` (household-contribution
 * ledger's own label) with the roster shape `renderOptionCell` needs, rather
 * than re-declaring the three labels here.
 */
export const ledgerPartyKindOptions: FilterableComboboxItem[] =
  ledgerPartyKindValues.map((value) => ({
    value,
    label: ledgerPartyLabel(value),
    color: value === "household" ? "var(--primary)" : "var(--slate)",
  }));

export function createLedgerPartyIdentityColumn(
  helper: CubbyColumnHelper<LedgerPartyOut>,
  className = "w-64",
) {
  return helper.accessor("name", {
    header: "Name",
    meta: { className, mobile: { slot: "title", priority: 0 } },
    cell: (info) => (
      <TableLink
        to={entities.ledgerParty.routes.detail}
        params={entityDetailParams(info.row.original.id)}
        className="block truncate"
      >
        {info.getValue()}
      </TableLink>
    ),
  });
}

export function createLedgerPartyKindColumn(
  helper: CubbyColumnHelper<LedgerPartyOut>,
  className = "w-32",
) {
  return helper.accessor("kind", {
    header: "Kind",
    meta: { className },
    cell: (info) => renderOptionCell(info.getValue(), ledgerPartyKindOptions),
  });
}
