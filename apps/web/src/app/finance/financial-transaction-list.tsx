import type {
  FinancialTransactionFilters,
  FinancialTransactionOut,
} from "@cubby/schemas/financial-transaction";
import { createColumnHelper } from "@tanstack/react-table";
import { useMemo } from "react";
import { entities, entityDetailParams } from "~/entities/entities";
import { useTRPC } from "~/integrations/trpc/react";
import { financialTransactionMutationInvalidateKeys } from "~/lib/query-keys";
import { formatCurrency } from "~/lib/utils";
import {
  createPlainDateColumn,
  createTextColumn,
} from "../_components/data-table/columnHelpers";
import RTable from "../_components/data-table/Table";
import { useDeletableConfig } from "../_components/hooks/useDeletableConfig";
import { useEntityList } from "../_components/hooks/useEntityList";
import { TableLink } from "../_components/table/TableLink";
export function FinancialTransactionList() {
  const api = useTRPC();
  const helper = useMemo(
    () => createColumnHelper<FinancialTransactionOut>(),
    [],
  );
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
      createTextColumn(helper, "kind", { header: "Kind", className: "w-32" }),
      createTextColumn(helper, "status", {
        header: "Status",
        className: "w-24",
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
      createPlainDateColumn(helper, "postedDate", { header: "Posted" }),
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
