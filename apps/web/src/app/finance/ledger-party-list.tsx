import type {
  LedgerPartyFilters,
  LedgerPartyOut,
} from "@cubby/schemas/ledger-party";
import { useMemo } from "react";

import { EntityListPage } from "~/app/_components/data-table/EntityListPage";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
} from "~/app/_components/data-table/table-features";
import { createEntityDisplayColumns } from "~/entities/entity-display";
import { entityListFor } from "~/entities/entity-list.functions";

import {
  createLedgerPartyIdentityColumn,
  createLedgerPartyKindColumn,
} from "./ledger-party-columns";

/**
 * Household members, guests, and the household itself — the parties a
 * contribution or transfer can name. Read-only for now: no create dialog,
 * matching `LedgerParty`'s manifest (created through the household
 * contribution ledger, not a standalone form).
 */
export function LedgerPartyList() {
  const helper = useMemo(() => createCubbyColumnHelper<LedgerPartyOut>(), []);
  const columns = useMemo(
    () =>
      createEntityDisplayColumns(
        "ledgerParty",
        helper,
        createCubbyColumnCollection<LedgerPartyOut>((add) => {
          add(createLedgerPartyIdentityColumn(helper));
          add(createLedgerPartyKindColumn(helper));
        }),
      ),
    [helper],
  );
  return (
    <EntityListPage<LedgerPartyOut, LedgerPartyFilters>
      entity="ledgerParty"
      queryOptions={entityListFor("ledgerParty").listQueryPlan}
      columns={columns}
      ariaLabel="Ledger parties"
    />
  );
}
