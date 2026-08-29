import type {
  FinancialAccountFilters,
  FinancialAccountOut,
} from "@cubby/schemas/financial-account";
import type { LedgerPartyShortcode } from "@cubby/schemas/identifiers";
import { useMemo } from "react";

import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
} from "~/app/_components/data-table/table-features";
import { NoneValue } from "~/components/ui/none-value";
import { entities, entityDetailParams } from "~/entities/entities";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import { entityListFor } from "~/entities/entity-list.functions";

import {
  createBooleanColumn,
  renderOptionCell,
} from "../_components/data-table/columnHelpers";
import { EditableEntityCell } from "../_components/data-table/editable-entity-cell";
import { EntityListPage } from "../_components/data-table/EntityListPage";
import { useDeletableConfig } from "../_components/hooks/useDeletableConfig";
import { useUpdateMutation } from "../_components/hooks/useUpdateMutation";
import { TableLink } from "../_components/table/TableLink";
import {
  accountIdentityKindOptions,
  provisionalOptions,
} from "./financial-account-options";
import { WithLedgerPartySearch } from "./financial-selectors";
export function FinancialAccountList() {
  const helper = useMemo(
    () => createCubbyColumnHelper<FinancialAccountOut>(),
    [],
  );
  const deletable = useDeletableConfig({
    mutationFn: entityMutationOptionsFactory("financialAccount", "delete"),
    entity: "financialAccount",
  });
  const updateAccountMutation = useUpdateMutation({
    mutationFn: entityMutationOptionsFactory("financialAccount", "update"),
    entity: "financialAccount",
  });
  const columns = useMemo(
    () =>
      createCubbyColumnCollection<FinancialAccountOut>((add) => {
        add(
          helper.accessor("name", {
            header: "Account",
            meta: { className: "w-64", mobile: { slot: "title", priority: 0 } },
            cell: (i) => (
              <TableLink
                to={entities.financialAccount.routes.detail}
                params={entityDetailParams(i.row.original.id)}
                className="block truncate"
              >
                {i.getValue()}
              </TableLink>
            ),
          }),
        );
        add(
          // Load-bearing, not decorative: an Expense's funder is DERIVED from
          // the paying account's owner, so an account left unowned is spend the
          // contribution report cannot attribute to anyone.
          helper.accessor("ledgerPartyName", {
            header: "Owner",
            meta: { className: "w-36" },
            cell: (i) => {
              const account = i.row.original;
              const partyId = account.ledgerPartyId;
              return (
                <EditableEntityCell<LedgerPartyShortcode>
                  value={
                    partyId
                      ? {
                          id: partyId,
                          shortcode: partyId,
                          name: i.getValue() ?? partyId,
                        }
                      : null
                  }
                  label="ledgerParty"
                  SearchProvider={WithLedgerPartySearch}
                  clearable
                  onSave={async (ledgerPartyId) => {
                    await updateAccountMutation.mutateAsync({
                      id: account.id,
                      data: { ledgerPartyId },
                    });
                  }}
                  renderValue={(party) =>
                    party ? <span>{party.name}</span> : <NoneValue />
                  }
                />
              );
            },
          }),
        );
        add(
          helper.accessor("identity", {
            header: "Identity",
            meta: { className: "w-40" },
            cell: (i) =>
              renderOptionCell(i.getValue().kind, accountIdentityKindOptions),
          }),
        );
        add(
          createBooleanColumn(helper, "provisional", {
            header: "Status",
            className: "w-28",
            // The same roster the detail page renders from, so the two cannot drift.
            trueFalseOptions: provisionalOptions,
            editable: {
              // `NOT NULL DEFAULT false`, so there is no undecided state to clear to
              // and `next` is only ever a boolean.
              onSave: async (provisional, account) => {
                await updateAccountMutation.mutateAsync({
                  id: account.id,
                  data: { provisional: provisional ?? false },
                });
              },
            },
          }),
        );
        add(
          helper.accessor((r) => r.sourceAliases.length, {
            id: "aliases",
            header: "Aliases",
            meta: { numeric: true, className: "w-24" },
          }),
        );
      }),
    // oxlint-disable-next-line react/exhaustive-deps -- mutations change every render but are functionally stable
    [helper],
  );
  return (
    <EntityListPage<FinancialAccountOut, FinancialAccountFilters>
      entity="financialAccount"
      queryOptions={entityListFor("financialAccount").listQueryPlan}
      columns={columns}
      deletable={deletable}
      ariaLabel="Financial accounts"
    />
  );
}
