import type {
  LedgerTransferFilters,
  LedgerTransferOut,
} from "@cubby/schemas/ledger-transfer";
import { useMemo } from "react";

import { EntityListPage } from "~/app/_components/data-table/EntityListPage";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
} from "~/app/_components/data-table/table-features";
import { createEntityDisplayColumns } from "~/entities/entity-display";
import { entityListFor } from "~/entities/entity-list.functions";

import {
  createLedgerTransferAmountColumn,
  createLedgerTransferDateColumn,
  createLedgerTransferEvidenceCountColumn,
  createLedgerTransferFromPartyColumn,
  createLedgerTransferToPartyColumn,
} from "./ledger-transfer-columns";

/**
 * Money that moved between ledger parties after the fact, with its own
 * evidence — distinct from an `Expense`'s beneficiary/funder split. Read-only
 * for now: transfers are recorded through the household contribution ledger,
 * not a standalone create dialog here.
 */
export function LedgerTransferList() {
  const helper = useMemo(
    () => createCubbyColumnHelper<LedgerTransferOut>(),
    [],
  );
  const columns = useMemo(
    () =>
      createEntityDisplayColumns(
        "ledgerTransfer",
        helper,
        createCubbyColumnCollection<LedgerTransferOut>((add) => {
          add(createLedgerTransferFromPartyColumn(helper));
          add(createLedgerTransferToPartyColumn(helper));
          add(createLedgerTransferAmountColumn(helper));
          add(createLedgerTransferDateColumn(helper));
          add(createLedgerTransferEvidenceCountColumn(helper));
        }),
      ),
    [helper],
  );
  return (
    <EntityListPage<LedgerTransferOut, LedgerTransferFilters>
      entity="ledgerTransfer"
      queryOptions={entityListFor("ledgerTransfer").listQueryPlan}
      columns={columns}
      ariaLabel="Ledger transfers"
    />
  );
}
