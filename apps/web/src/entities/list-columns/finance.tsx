import type { FilterOptionsOut } from "@cubby/schemas/filter-options";
import type {
  FinancialAccountFilters,
  FinancialAccountOut,
} from "@cubby/schemas/financial-account";
import type {
  FinancialTransactionFilters,
  FinancialTransactionOut,
  FinancialTransactionSourceOptionsOut,
} from "@cubby/schemas/financial-transaction";
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

import { renderOptionCell } from "~/app/_components/data-table/columnHelpers";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  type CubbyColumnCollection,
} from "~/app/_components/data-table/table-features";
import { useDeletableConfig } from "~/app/_components/hooks/useDeletableConfig";
import { useFilterOptions } from "~/app/_components/hooks/useFilterOptions";
import { financialTransaction } from "~/app/finance/finance.functions";
import { accountIdentityKindOptions } from "~/app/finance/financial-account-options";
import { PossibleVendor } from "~/app/finance/possible-vendor";
import { NoneValue } from "~/components/ui/none-value";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import { entityListHiddenColumns } from "~/entities/entity-display";
import { entityFilterOptions } from "~/entities/entity-filter-options.functions";
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
    const overrides = useMemo(
      () =>
        createCubbyColumnCollection<FinancialAccountOut>((add) => {
          add(
            accountHelper.accessor("identity", {
              header: "Identity",
              meta: { className: "w-40" },
              cell: (i) =>
                renderOptionCell(i.getValue().kind, accountIdentityKindOptions),
            }),
          );
          add(
            accountHelper.accessor((r) => r.sourceAliases.length, {
              id: "sourceAliases",
              header: "Aliases",
              meta: { numeric: true, className: "w-24" },
            }),
          );
        }),
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
const NO_OPTIONS: FilterOptionsOut = { items: [], nextCursor: null };
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
      entityFilterOptions.filterOptions.queryOptions({
        source: "entity",
        entity: "financialAccount",
        limit: 1000,
        include: ["count"],
      }),
    );
    const { data: sources = NO_SOURCES } = useQuery(
      financialTransaction.sourceOptions.queryOptions(null),
    );
    const filterOptions = useFilterOptions({
      account: accounts.items.map((a) => ({
        value: a.id,
        label: a.label,
        hint: `${a.count ?? 0}`,
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
    const overrides = useMemo(
      () =>
        createCubbyColumnCollection<FinancialTransactionOut>((add) => {
          add(
            transactionHelper.accessor("vendorInference", {
              id: "vendorInference",
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
                id: "sourceRefs",
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

/** Read-only: created through the household contribution ledger. */
export const ledgerPartyListOverride = defineListOverride<
  LedgerPartyOut,
  LedgerPartyFilters
>({
  use: () => ({}),
});

/** Read-only: transfers are recorded through the contribution ledger. */
export const ledgerTransferListOverride = defineListOverride<
  LedgerTransferOut,
  LedgerTransferFilters
>({
  use: () => ({}),
});
