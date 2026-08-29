import type { FinancialAccountOptionsOut } from "@cubby/schemas/financial-account";
import type {
  FinancialTransactionFilters,
  FinancialTransactionOut,
  FinancialTransactionSourceOptionsOut,
} from "@cubby/schemas/financial-transaction";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
} from "~/app/_components/data-table/table-features";
import {
  financialAccount,
  financialTransaction,
} from "~/app/finance/finance.functions";
import { NoneValue } from "~/components/ui/none-value";
import { entities, entityDetailParams } from "~/entities/entities";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import { entityListFor } from "~/entities/entity-list.functions";
import { presenceCellOptions } from "~/lib/select-options";

import {
  createFilterableSelectColumn,
  createTextColumn,
  renderOptionCell,
} from "../_components/data-table/columnHelpers";
import { EntityListPage } from "../_components/data-table/EntityListPage";
import { useDeletableConfig } from "../_components/hooks/useDeletableConfig";
import { useFilterOptions } from "../_components/hooks/useFilterOptions";
import { TableLink } from "../_components/table/TableLink";
import {
  createFinancialTransactionAccountColumn,
  createFinancialTransactionAmountColumn,
  createFinancialTransactionIdentityColumn,
  createFinancialTransactionPostedDateColumn,
  createFinancialTransactionStatusColumn,
} from "./financial-transaction-columns";
import { financialTransactionKindOptions } from "./financial-transaction-kind-options";
import { PossibleVendor } from "./possible-vendor";

const PURCHASE_PRESENCE_OPTIONS = presenceCellOptions("purchase");

const NO_OPTIONS: FinancialAccountOptionsOut = [];
const NO_SOURCES: FinancialTransactionSourceOptionsOut = [];

/**
 * Module-level: this feeds the merged-visibility `useMemo`, so an inline object
 * literal would rebuild the table's column visibility on every render.
 */
export const FINANCIAL_TRANSACTION_INITIAL_COLUMN_VISIBILITY = {
  purchasePresence: false,
  merchant: false,
  possibleVendor: false,
  source: false,
};

export function FinancialTransactionList() {
  const helper = useMemo(
    () => createCubbyColumnHelper<FinancialTransactionOut>(),
    [],
  );
  // Eagerly-loaded rosters for the Account and Source header filters. The
  // transaction FORM uses a search-as-you-type account combobox instead — a
  // header control needs the whole list up front, a form does not.
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
    mutationFn: entityMutationOptionsFactory("financialTransaction", "delete"),
    entity: "financialTransaction",
  });
  const columns = useMemo(
    () =>
      createCubbyColumnCollection<FinancialTransactionOut>((add) => {
        add(createFinancialTransactionIdentityColumn(helper));
        add(createFinancialTransactionAccountColumn(helper));
        // Through the factory, not a bare accessor: these were `createTextColumn`,
        // which wires `meta.cellData` unconditionally, so hand-rolling the cell
        // dropped them out of the range copy/paste engine (which reads cellData,
        // never the rendered cell). `filterConfig: null` keeps `meta.filterConfig`
        // undefined exactly as `createTextColumn` left it, so the manifest's
        // multiselect control stays the one that attaches.
        add(
          createFilterableSelectColumn(helper, "kind", {
            header: "Kind",
            className: "w-32",
            placeholder: "Filter by kind...",
            selectOptions: financialTransactionKindOptions,
            filterConfig: null,
          }),
        );
        add(createFinancialTransactionStatusColumn(helper));
        add(createFinancialTransactionAmountColumn(helper));
        add(
          helper.accessor("purchaseId", {
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
        add(createFinancialTransactionPostedDateColumn(helper));
        // Hidden by default: these exist so `purchasePresence`, `merchant` and
        // `source` are column-backed specs rather than URL-only ones. A urlOnly
        // spec can never round-trip through a header control — see
        // `manifestFilterConfig`.
        add(
          helper.accessor((r) => r.purchaseId, {
            id: "purchasePresence",
            header: "Linked",
            enableSorting: false,
            meta: { className: "w-24" },
            cell: (i) =>
              renderOptionCell(
                i.getValue() ? "yes" : "no",
                PURCHASE_PRESENCE_OPTIONS,
              ),
          }),
        );
        add(
          createTextColumn(helper, "merchant", {
            header: "Merchant",
            className: "w-40",
          }),
        );
        add(
          helper.accessor("vendorInference", {
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
          helper.accessor(
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
    [helper],
  );
  return (
    <EntityListPage<FinancialTransactionOut, FinancialTransactionFilters>
      entity="financialTransaction"
      queryOptions={entityListFor("financialTransaction").listQueryPlan}
      columns={columns}
      deletable={deletable}
      filterOptions={filterOptions}
      initialColumnVisibility={FINANCIAL_TRANSACTION_INITIAL_COLUMN_VISIBILITY}
      ariaLabel="Financial transactions"
    />
  );
}
