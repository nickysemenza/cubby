import type { LedgerPartyOut } from "@cubby/schemas/ledger-party";

import type { CubbyColumnHelper } from "~/app/_components/data-table/table-features";
import { TableLink } from "~/app/_components/table/TableLink";
import { entities, entityDetailParams } from "~/entities/entities";

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
