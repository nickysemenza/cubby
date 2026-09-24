import type { LedgerTransferOut } from "@cubby/schemas/ledger-transfer";

import type { CubbyColumnHelper } from "~/app/_components/data-table/table-features";
import { TableLink } from "~/app/_components/table/TableLink";
import type { FilterableComboboxItem } from "~/components/ui/combobox";
import { entities, entityDetailParams } from "~/entities/entities";
import { formatCurrency } from "~/lib/utils";

/**
 * Labels for `LedgerTransfer.classification`, the server-derived reading of
 * what a transfer represents (never a stored input — see
 * `ledgerTransferOut.classification`). Detail-page only today; add here
 * rather than the list so a future list column reuses the same roster.
 */
export const ledgerTransferClassificationOptions: FilterableComboboxItem[] = [
  { value: "internal_move", label: "Internal move", color: "var(--slate)" },
  { value: "contribution", label: "Contribution", color: "var(--positive)" },
  {
    value: "household_distribution",
    label: "Household distribution",
    color: "var(--primary)",
  },
  { value: "reimbursement", label: "Reimbursement", color: "var(--warning)" },
];

/**
 * A transfer has no name of its own — its identity is (from, to, date,
 * amount) — so the from/to party columns double as the row's title, same
 * convention as purchase's (vendor, orderId, date) identity.
 */
function createLedgerTransferPartyColumn(
  helper: CubbyColumnHelper<LedgerTransferOut>,
  accessor: "fromPartyId" | "toPartyId",
  header: string,
  className: string,
) {
  return helper.accessor(
    (row) => (accessor === "fromPartyId" ? row.fromPartyName : row.toPartyName),
    {
      id: accessor,
      header,
      meta: {
        className,
        mobile:
          accessor === "fromPartyId"
            ? { slot: "title", priority: 0 }
            : { slot: "subtitle", priority: 10 },
      },
      cell: (info) => (
        <TableLink
          to={entities.ledgerParty.routes.detail}
          params={entityDetailParams(info.row.original[accessor])}
          className="block truncate"
        >
          {info.getValue()}
        </TableLink>
      ),
    },
  );
}

export function createLedgerTransferFromPartyColumn(
  helper: CubbyColumnHelper<LedgerTransferOut>,
  className = "w-40",
) {
  return createLedgerTransferPartyColumn(
    helper,
    "fromPartyId",
    "From",
    className,
  );
}

export function createLedgerTransferToPartyColumn(
  helper: CubbyColumnHelper<LedgerTransferOut>,
  className = "w-40",
) {
  return createLedgerTransferPartyColumn(helper, "toPartyId", "To", className);
}

export function createLedgerTransferAmountColumn(
  helper: CubbyColumnHelper<LedgerTransferOut>,
  className = "w-28",
) {
  return helper.accessor("amount", {
    header: "Amount",
    meta: {
      numeric: true,
      className,
      mobile: { slot: "trailing", priority: 1 },
    },
    cell: (info) => formatCurrency(info.getValue()),
  });
}

export function createLedgerTransferEvidenceCountColumn(
  helper: CubbyColumnHelper<LedgerTransferOut>,
  className = "w-24",
) {
  return helper.accessor((row) => row.evidenceTransactionIds.length, {
    id: "evidenceTransactionIds",
    header: "Evidence",
    meta: { numeric: true, className, mobile: { slot: "hidden" } },
  });
}
