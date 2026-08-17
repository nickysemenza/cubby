import type { FinancialAccountOptionsOut } from "@cubby/schemas/financial-account";
import type {
  FinancialTransactionFilters,
  FinancialTransactionOut,
  FinancialTransactionSourceOptionsOut,
} from "@cubby/schemas/financial-transaction";
import { useQuery } from "@tanstack/react-query";
import { createColumnHelper } from "@tanstack/react-table";
import { useMemo } from "react";
import { NoneValue } from "~/components/ui/none-value";
import { entities, entityDetailParams } from "~/entities/entities";
import { useTRPC } from "~/integrations/trpc/react";
import { financialTransactionMutationInvalidateKeys } from "~/lib/query-keys";
import { presenceCellOptions } from "~/lib/select-options";
import { formatCurrency } from "~/lib/utils";
import {
  createFilterableSelectColumn,
  createPlainDateColumn,
  createTextColumn,
  renderOptionCell,
} from "../_components/data-table/columnHelpers";
import RTable from "../_components/data-table/Table";
import { useDeletableConfig } from "../_components/hooks/useDeletableConfig";
import { useEntityList } from "../_components/hooks/useEntityList";
import { useFilterOptions } from "../_components/hooks/useFilterOptions";
import { TableLink } from "../_components/table/TableLink";
import {
  financialTransactionKindOptions,
  financialTransactionStatusOptions,
} from "./financial-transaction-kind-options";

const PURCHASE_PRESENCE_OPTIONS = presenceCellOptions("purchase");

const NO_OPTIONS: FinancialAccountOptionsOut = [];
const NO_SOURCES: FinancialTransactionSourceOptionsOut = [];

export function FinancialTransactionList() {
  const api = useTRPC();
  const helper = useMemo(
    () => createColumnHelper<FinancialTransactionOut>(),
    [],
  );
  // Eagerly-loaded rosters for the Account and Source header filters. The
  // transaction FORM uses a search-as-you-type account combobox instead — a
  // header control needs the whole list up front, a form does not.
  const { data: accounts = NO_OPTIONS } = useQuery(
    api.financialAccount.options.queryOptions(),
  );
  const { data: sources = NO_SOURCES } = useQuery(
    api.financialTransaction.sourceOptions.queryOptions(),
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
    mutationFn: api.financialTransaction.delete.mutationOptions,
    entityLabel: "Transaction",
    entity: "financialTransaction",
    invalidateKeys: financialTransactionMutationInvalidateKeys,
  });
  const columns = useMemo(
    () => [
      helper.accessor((r) => r.merchant || r.rawDescription || r.id, {
        id: "transaction",
        header: "Transaction",
        meta: { className: "w-64", mobile: { slot: "title", priority: 0 } },
        cell: (i) => (
          <TableLink
            to={entities.financialTransaction.routes.detail}
            params={entityDetailParams(i.row.original.id)}
            className="block truncate"
          >
            {i.getValue()}
          </TableLink>
        ),
      }),
      helper.accessor("accountId", {
        header: "Account",
        meta: { className: "w-40" },
        cell: (i) => (
          <TableLink
            to={entities.financialAccount.routes.detail}
            params={entityDetailParams(i.getValue())}
            className="block truncate"
          >
            {i.row.original.accountName ?? i.getValue()}
          </TableLink>
        ),
      }),
      // Through the factory, not a bare accessor: these were `createTextColumn`,
      // which wires `meta.cellData` unconditionally, so hand-rolling the cell
      // dropped them out of the range copy/paste engine (which reads cellData,
      // never the rendered cell). `filterConfig: null` keeps `meta.filterConfig`
      // undefined exactly as `createTextColumn` left it, so the manifest's
      // multiselect control stays the one that attaches.
      createFilterableSelectColumn(helper, "kind", {
        header: "Kind",
        className: "w-32",
        placeholder: "Filter by kind...",
        selectOptions: financialTransactionKindOptions,
        filterConfig: null,
      }),
      createFilterableSelectColumn(helper, "status", {
        header: "Status",
        className: "w-24",
        placeholder: "Filter by status...",
        selectOptions: financialTransactionStatusOptions,
        filterConfig: null,
      }),
      helper.accessor("amount", {
        header: "Amount",
        meta: {
          numeric: true,
          className: "w-28",
          mobile: { slot: "trailing", priority: 1 },
        },
        cell: (i) => formatCurrency(i.getValue()),
      }),
      helper.accessor("purchaseId", {
        header: "Purchase",
        meta: { className: "w-32" },
        cell: (i) =>
          i.getValue() ? (
            <TableLink
              to={entities.purchase.routes.detail}
              params={entityDetailParams(i.getValue() as string)}
              variant="mono"
            >
              {i.getValue()}
            </TableLink>
          ) : (
            "—"
          ),
      }),
      createPlainDateColumn(helper, "postedDate", { header: "Posted" }),
      // Hidden by default: these exist so `purchasePresence`, `merchant` and
      // `source` are column-backed specs rather than URL-only ones. A urlOnly
      // spec can never round-trip through a header control — see
      // `manifestFilterConfig`.
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
      createTextColumn(helper, "merchant", {
        header: "Merchant",
        className: "w-40",
      }),
      helper.accessor((r) => r.sourceRefs.map((ref) => ref.source).join(", "), {
        id: "source",
        header: "Source",
        enableSorting: false,
        meta: { className: "w-32" },
        cell: (i) => i.getValue() || <NoneValue />,
      }),
    ],
    [helper],
  );
  const list = useEntityList<
    FinancialTransactionOut,
    FinancialTransactionFilters
  >({
    entity: "financialTransaction",
    queryOptions: api.financialTransaction.list.queryOptions,
    columns,
    deletable,
    filterOptions,
    initialColumnVisibility: {
      purchasePresence: false,
      merchant: false,
      source: false,
    },
  });
  return (
    <>
      <RTable
        table={list.table}
        isLoading={list.isLoading}
        error={list.error}
        timing={list.timing}
        entity="financialTransaction"
        ariaLabel="Financial transactions"
        bulkActionBar={list.bulkActionBar}
        infiniteScroll={list.infiniteScroll}
        refreshControls={list.refreshControls}
      />
      {list.deleteDialog}
    </>
  );
}
