import type { PurchaseShortcode } from "@cubby/schemas/identifiers";
import type { ExpenseFilters, ExpenseOut } from "@cubby/schemas/project";
import { createColumnHelper } from "@tanstack/react-table";
import { useMemo } from "react";
import {
  createProductLinkColumn,
  createProjectLinkColumn,
} from "~/app/_components/data-table/columnHelpers";
import RTable from "~/app/_components/data-table/Table";
import { useDeletableConfig } from "~/app/_components/hooks/useDeletableConfig";
import { useEntityList } from "~/app/_components/hooks/useEntityList";
import { useNameEditable } from "~/app/_components/hooks/useNameEditable";
import { useUpdateMutation } from "~/app/_components/hooks/useUpdateMutation";
import {
  ExpenseBulkActionDialogs,
  useExpenseBulkActions,
} from "~/app/_components/tracker/expense-bulk-actions";
import {
  expenseCostColumn,
  expenseCostTypeColumn,
  expenseDateColumn,
  expenseFutureColumn,
  expenseTradeColumn,
} from "~/app/projects/shared";
import { useTRPC } from "~/integrations/trpc/react";
import { expenseMutationInvalidateKeys } from "~/lib/query-keys";

const EMBEDDED_TABLE_STATE = {
  initialSort: "date",
  urlSync: false,
  syncPaginationToUrl: false,
} as const;

/** Server-backed Expense list for one Purchase; Product is intentionally on. */
export function PurchaseExpensesTable({
  purchaseId,
}: {
  purchaseId: PurchaseShortcode;
}) {
  const api = useTRPC();
  const helper = useMemo(() => createColumnHelper<ExpenseOut>(), []);
  const scope = useMemo<Partial<ExpenseFilters>>(
    () => ({ purchaseId }),
    [purchaseId],
  );
  const update = useUpdateMutation({
    mutationFn: api.expense.update.mutationOptions,
    entity: "expense",
    invalidateKeys: expenseMutationInvalidateKeys,
  });
  const nameEditable = useNameEditable<ExpenseOut>(update.mutateAsync);
  const deletable = useDeletableConfig({
    mutationFn: api.expense.delete.mutationOptions,
    entityLabel: "Expense",
    entity: "expense",
    invalidateKeys: expenseMutationInvalidateKeys,
  });
  const bulkActions = useExpenseBulkActions();
  // biome-ignore lint/correctness/useExhaustiveDependencies: mutation wrappers are functionally stable
  const columns = useMemo(
    () => [
      expenseCostColumn(
        helper,
        async (cost, row) => {
          await update.mutateAsync({ id: row.id, data: { cost } });
        },
        { signedTone: true },
      ),
      expenseDateColumn(helper, async (date, row) => {
        await update.mutateAsync({ id: row.id, data: { date } });
      }),
      expenseCostTypeColumn(helper, async (costType, row) => {
        await update.mutateAsync({ id: row.id, data: { costType } });
      }),
      expenseTradeColumn(helper, async (trade, row) => {
        await update.mutateAsync({ id: row.id, data: { trade } });
      }),
      expenseFutureColumn(helper, async (future, row) => {
        await update.mutateAsync({ id: row.id, data: { future } });
      }),
      createProductLinkColumn(helper, {
        className: "w-48",
        editable: {
          onSave: async (productId, row) => {
            await update.mutateAsync({ id: row.id, data: { productId } });
          },
        },
      }),
      createProjectLinkColumn(helper, {
        className: "w-48",
        editable: {
          onSave: async (projectId, row) => {
            await update.mutateAsync({ id: row.id, data: { projectId } });
          },
        },
      }),
    ],
    [helper],
  );
  const list = useEntityList<ExpenseOut, ExpenseFilters>({
    entity: "expense",
    queryOptions: api.expense.list.queryOptions,
    extraFilters: scope,
    columns,
    tableStateOptions: EMBEDDED_TABLE_STATE,
    columnVisibilityScope: "purchase-detail",
    hiddenFilterColumns: ["vendor", "orderId"],
    deletable,
    nameEditable,
    bulkActions: bulkActions.config,
    initialColumnVisibility: {
      product: true,
      project: false,
      createdAt: false,
    },
  });
  return (
    <>
      <RTable
        table={list.table}
        isLoading={list.isLoading}
        error={list.error}
        timing={list.timing}
        sizingKey="expense:purchase-detail"
        ariaLabel="Purchase expenses"
        embedded
        showColumnMenu
        bulkActionBar={list.bulkActionBar}
        infiniteScroll={list.infiniteScroll}
        refreshControls={list.refreshControls}
      />
      {list.deleteDialog}
      <ExpenseBulkActionDialogs
        controller={bulkActions}
        onComplete={() => list.table.resetRowSelection()}
      />
    </>
  );
}
