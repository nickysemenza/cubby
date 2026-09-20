import type {
  FinancialAccountFilters,
  FinancialAccountOptionsOut,
  FinancialAccountOut,
} from "@cubby/schemas/financial-account";
import type {
  FinancialTransactionFilters,
  FinancialTransactionOut,
  FinancialTransactionSourceOptionsOut,
} from "@cubby/schemas/financial-transaction";
import type { LedgerPartyShortcode } from "@cubby/schemas/identifiers";
import type {
  LedgerPartyFilters,
  LedgerPartyOut,
} from "@cubby/schemas/ledger-party";
import type {
  LedgerTransferFilters,
  LedgerTransferOut,
} from "@cubby/schemas/ledger-transfer";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import {
  createBooleanColumn,
  createFilterableSelectColumn,
  renderOptionCell,
} from "~/app/_components/data-table/columnHelpers";
import { EditableEntityCell } from "~/app/_components/data-table/editable-entity-cell";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  type CubbyColumnCollection,
} from "~/app/_components/data-table/table-features";
import { useDeletableConfig } from "~/app/_components/hooks/useDeletableConfig";
import { useFilterOptions } from "~/app/_components/hooks/useFilterOptions";
import { useUpdateMutation } from "~/app/_components/hooks/useUpdateMutation";
import { TableLink } from "~/app/_components/table/TableLink";
import {
  financialAccount,
  financialTransaction,
} from "~/app/finance/finance.functions";
import {
  accountIdentityKindOptions,
  provisionalOptions,
} from "~/app/finance/financial-account-options";
import { WithLedgerPartySearch } from "~/app/finance/financial-selectors";
import {
  createFinancialTransactionAccountColumn,
  createFinancialTransactionAmountColumn,
  createFinancialTransactionIdentityColumn,
  createFinancialTransactionStatusColumn,
} from "~/app/finance/financial-transaction-columns";
import { financialTransactionKindOptions } from "~/app/finance/financial-transaction-kind-options";
import {
  createLedgerPartyIdentityColumn,
  createLedgerPartyKindColumn,
} from "~/app/finance/ledger-party-columns";
import {
  createLedgerTransferAmountColumn,
  createLedgerTransferEvidenceCountColumn,
  createLedgerTransferFromPartyColumn,
  createLedgerTransferToPartyColumn,
} from "~/app/finance/ledger-transfer-columns";
import { PossibleVendor } from "~/app/finance/possible-vendor";
import { NoneValue } from "~/components/ui/none-value";
import { entities, entityDetailParams } from "~/entities/entities";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import { entityListHiddenColumns } from "~/entities/entity-display";
import { relationshipFieldProvenance } from "~/entities/field-provenance";
import { presenceCellOptions } from "~/lib/select-options";

import { defineListOverride, interleaveDeclared } from "./types";

/* ---------------------------------------------------------------------- */
/* Financial accounts                                                      */
/* ---------------------------------------------------------------------- */

const accountHelper = createCubbyColumnHelper<FinancialAccountOut>();

export const financialAccountListOverride = defineListOverride<
  FinancialAccountOut,
  FinancialAccountFilters
>({
  use() {
    const deletable = useDeletableConfig({
      mutationFn: entityMutationOptionsFactory("financialAccount", "delete"),
      entity: "financialAccount",
    });
    const updateAccountMutation = useUpdateMutation({
      mutationFn: entityMutationOptionsFactory("financialAccount", "update"),
      entity: "financialAccount",
    });
    const overrides = useMemo(
      () =>
        createCubbyColumnCollection<FinancialAccountOut>((add) => {
          add(
            accountHelper.accessor("name", {
              header: "Account",
              meta: {
                className: "w-64",
                mobile: { slot: "title", priority: 0 },
              },
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
          // Load-bearing: an Expense's funder is DERIVED from the paying
          // account's owner, so an unowned account is spend the contribution
          // report cannot attribute.
          add(
            accountHelper.accessor("ledgerPartyName", {
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
            accountHelper.accessor("identity", {
              header: "Identity",
              meta: { className: "w-40" },
              cell: (i) =>
                renderOptionCell(i.getValue().kind, accountIdentityKindOptions),
            }),
          );
          add(
            createBooleanColumn(accountHelper, "provisional", {
              header: "Status",
              className: "w-28",
              trueFalseOptions: provisionalOptions,
              editable: {
                // `NOT NULL DEFAULT false`: no undecided state to clear to.
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
            accountHelper.accessor((r) => r.sourceAliases.length, {
              id: "aliases",
              header: "Aliases",
              meta: { numeric: true, className: "w-24" },
            }),
          );
        }),
      // oxlint-disable-next-line react/exhaustive-deps -- mutations change every render but are functionally stable
      [],
    );
    const list = useMemo(() => ({ deletable }), [deletable]);
    return { overrides, list };
  },
});

/* ---------------------------------------------------------------------- */
/* Financial transactions                                                  */
/* ---------------------------------------------------------------------- */

const transactionHelper = createCubbyColumnHelper<FinancialTransactionOut>();
const PURCHASE_PRESENCE_OPTIONS = presenceCellOptions("purchase");
const NO_OPTIONS: FinancialAccountOptionsOut = [];
const NO_SOURCES: FinancialTransactionSourceOptionsOut = [];

// `purchasePresence` is a filter-hosting synthetic column outside the field
// model.
const FINANCIAL_TRANSACTION_INITIAL_COLUMN_VISIBILITY = {
  purchasePresence: false,
  ...entityListHiddenColumns("financialTransaction"),
};

export const financialTransactionListOverride = defineListOverride<
  FinancialTransactionOut,
  FinancialTransactionFilters
>({
  use() {
    // Eagerly-loaded rosters for the Account and Source header filters (a
    // header control needs the whole list up front).
    const { data: accounts = NO_OPTIONS } = useQuery(
      financialAccount.options.queryOptions(null),
    );
    const { data: sources = NO_SOURCES } = useQuery(
      financialTransaction.sourceOptions.queryOptions(null),
    );
    const filterOptions = useFilterOptions({
      account: accounts.map((a) => ({
        value: a.id,
        label: a.name,
        hint: `${a.count}`,
      })),
      source: sources.map((s) => ({
        value: s.source,
        label: s.source,
        hint: `${s.count}`,
      })),
    });
    const deletable = useDeletableConfig({
      mutationFn: entityMutationOptionsFactory(
        "financialTransaction",
        "delete",
      ),
      entity: "financialTransaction",
    });
    // `vendorInference` / `sourceRefs` keep their `possibleVendor` / `source`
    // column ids via `display.columnId` (persisted layouts, filter bindings
    // and sort ids can't silently rename).
    const overrides = useMemo(
      () =>
        createCubbyColumnCollection<FinancialTransactionOut>((add) => {
          add(createFinancialTransactionAccountColumn(transactionHelper));
          // `filterConfig: null` keeps `meta.filterConfig` undefined so the
          // manifest's multiselect control stays the one that attaches.
          add(
            createFilterableSelectColumn(transactionHelper, "kind", {
              header: "Kind",
              className: "w-32",
              placeholder: "Filter by kind...",
              selectOptions: financialTransactionKindOptions,
              filterConfig: null,
            }),
          );
          add(createFinancialTransactionStatusColumn(transactionHelper));
          add(createFinancialTransactionAmountColumn(transactionHelper));
          add(
            transactionHelper.accessor("purchaseId", {
              header: "Purchase",
              meta: { className: "w-32" },
              cell: (i) => {
                const purchaseId = i.getValue();
                return purchaseId ? (
                  <TableLink
                    to={entities.purchase.routes.detail}
                    params={entityDetailParams(purchaseId)}
                    variant="mono"
                  >
                    {purchaseId}
                  </TableLink>
                ) : (
                  "—"
                );
              },
            }),
          );
          add(
            transactionHelper.accessor("vendorInference", {
              id: "possibleVendor",
              header: "Possible vendor",
              enableSorting: false,
              meta: { className: "w-48", mobile: { slot: "hidden" } },
              cell: (info) =>
                info.getValue() ? (
                  <PossibleVendor inference={info.getValue()} compact />
                ) : (
                  <NoneValue />
                ),
            }),
          );
          add(
            transactionHelper.accessor(
              (r) => r.sourceRefs.map((ref) => ref.source).join(", "),
              {
                id: "source",
                header: "Source",
                enableSorting: false,
                meta: { className: "w-32" },
                cell: (i) => i.getValue() || <NoneValue />,
              },
            ),
          );
        }),
      [],
    );
    const compose = useMemo(
      () => (declared: CubbyColumnCollection<FinancialTransactionOut>) =>
        createCubbyColumnCollection<FinancialTransactionOut>((add) => {
          const { rest } = interleaveDeclared(declared, add);
          add(createFinancialTransactionIdentityColumn(transactionHelper));
          // Hidden by default: exists so `purchasePresence` is a column-backed
          // spec rather than a urlOnly one; derived from `purchaseId`'s
          // presence, not a scalar of its own.
          add(
            transactionHelper.accessor((r) => r.purchaseId, {
              id: "purchasePresence",
              header: "Linked",
              enableSorting: false,
              meta: {
                provenance: relationshipFieldProvenance(
                  "financialTransaction",
                  "purchase",
                ),
                className: "w-24",
              },
              cell: (i) =>
                renderOptionCell(
                  i.getValue() ? "yes" : "no",
                  PURCHASE_PRESENCE_OPTIONS,
                ),
            }),
          );
          rest();
        }),
      [],
    );
    const list = useMemo(
      () => ({
        deletable,
        filterOptions,
        initialColumnVisibility:
          FINANCIAL_TRANSACTION_INITIAL_COLUMN_VISIBILITY,
      }),
      [deletable, filterOptions],
    );
    return { overrides, compose, list };
  },
});

/* ---------------------------------------------------------------------- */
/* Ledger parties and transfers                                            */
/* ---------------------------------------------------------------------- */

const partyHelper = createCubbyColumnHelper<LedgerPartyOut>();
const partyOverrides = createCubbyColumnCollection<LedgerPartyOut>((add) => {
  add(createLedgerPartyIdentityColumn(partyHelper));
  add(createLedgerPartyKindColumn(partyHelper));
});

/** Read-only: created through the household contribution ledger. */
export const ledgerPartyListOverride = defineListOverride<
  LedgerPartyOut,
  LedgerPartyFilters
>({
  use: () => ({ overrides: partyOverrides }),
});

const transferHelper = createCubbyColumnHelper<LedgerTransferOut>();
const transferOverrides = createCubbyColumnCollection<LedgerTransferOut>(
  (add) => {
    add(createLedgerTransferFromPartyColumn(transferHelper));
    add(createLedgerTransferToPartyColumn(transferHelper));
    add(createLedgerTransferAmountColumn(transferHelper));
    add(createLedgerTransferEvidenceCountColumn(transferHelper));
  },
);

/** Read-only: transfers are recorded through the contribution ledger. */
export const ledgerTransferListOverride = defineListOverride<
  LedgerTransferOut,
  LedgerTransferFilters
>({
  use: () => ({ overrides: transferOverrides }),
});
