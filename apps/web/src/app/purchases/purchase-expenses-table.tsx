import { expenseLineKindValues } from "@cubby/schemas/expense-line-kind";
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
  createExpenseProductImageColumn,
  ExpenseProductImages,
} from "~/app/expenses/expense-product-image-column";
import {
  expenseCostColumn,
  expenseCostTypeColumn,
  expenseDateColumn,
  expenseFutureColumn,
  expenseLineKindColumn,
  expenseProductQuantityColumn,
  expenseTradeColumn,
} from "~/app/projects/shared";
import { Stack } from "~/components/layout";
import { useTRPC } from "~/integrations/trpc/react";
import { expenseMutationInvalidateKeys } from "~/lib/query-keys";

const EMBEDDED_TABLE_STATE = {
  initialSort: "date",
  urlSync: false,
  readUrlState: false,
  syncPaginationToUrl: false,
} as const;

/** Server-backed Expense list for one Purchase; Product is intentionally on. */
export function PurchaseExpensesTable({
  purchaseId,
}: {
  purchaseId: PurchaseShortcode;
}) {
  return (
    <Stack gap="lg">
      <PurchaseExpenseRows purchaseId={purchaseId} kind="principal" />
      <Stack gap="sm">
        <div>
          <h3 className="font-medium text-sm">Receipt adjustments</h3>
          <p className="text-muted-foreground text-xs">
            Tax, shipping, discounts, fees, and tips remain spend but are not
            assigned to cost-type or trade analytics.
          </p>
        </div>
        <PurchaseExpenseRows purchaseId={purchaseId} kind="adjustment" />
      </Stack>
    </Stack>
  );
}

function PurchaseExpenseRows({
  purchaseId,
  kind,
}: {
  purchaseId: PurchaseShortcode;
  kind: "principal" | "adjustment";
}) {
  const api = useTRPC();
  const helper = useMemo(() => createColumnHelper<ExpenseOut>(), []);
  const scope = useMemo<Partial<ExpenseFilters>>(
    () => ({
      purchaseId,
      lineKind:
        kind === "principal"
          ? "principal"
          : expenseLineKindValues.filter((value) => value !== "principal"),
    }),
    [purchaseId, kind],
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
  const columns = useMemo(() => {
    const shared = [
      expenseCostColumn(
        helper,
        async (cost, row) => {
          await update.mutateAsync({ id: row.id, data: { cost } });
        },
        { signedTone: true },
      ),
      expenseDateColumn(helper, async (date, row) => {
        if (date === null) return;
        await update.mutateAsync({ id: row.id, data: { date } });
      }),
      expenseLineKindColumn(helper, async (lineKind, row) => {
        await update.mutateAsync({ id: row.id, data: { lineKind } });
      }),
      expenseFutureColumn(helper, async (future, row) => {
        await update.mutateAsync({ id: row.id, data: { future } });
      }),
      createProjectLinkColumn(helper, {
        className: "w-48",
        editable: {
          onSave: async (projectId, row) => {
            await update.mutateAsync({ id: row.id, data: { projectId } });
          },
        },
      }),
    ];
    if (kind === "adjustment") return shared;
    return [
      createExpenseProductImageColumn(helper),
      ...shared,
      expenseCostTypeColumn(helper, async (costType, row) => {
        await update.mutateAsync({ id: row.id, data: { costType } });
      }),
      expenseTradeColumn(helper, async (trade, row) => {
        await update.mutateAsync({ id: row.id, data: { trade } });
      }),
      createProductLinkColumn(helper, {
        className: "w-48",
        editable: {
          onSave: async (productId, row) => {
            await update.mutateAsync({ id: row.id, data: { productId } });
          },
        },
      }),
      expenseProductQuantityColumn(helper, async (productQuantity, row) => {
        await update.mutateAsync({
          id: row.id,
          data: { productQuantity },
        });
      }),
    ];
  }, [helper, kind]);
  const list = useEntityList<ExpenseOut, ExpenseFilters>({
    entity: "expense",
    queryOptions: api.expense.list.queryOptions,
    scopeFilters: scope,
    columns,
    tableStateOptions: EMBEDDED_TABLE_STATE,
    columnVisibilityScope: `purchase-detail-${kind}`,
    hiddenFilterColumns: ["vendor", "orderId"],
    deletable,
    nameEditable,
    bulkActions: bulkActions.config,
    initialColumnVisibility: {
      product: kind === "principal",
      productQuantity: kind === "principal",
      // A purchase can fund more than one project; keep the editable allocation
      // visible rather than hiding it behind the column menu.
      project: true,
      lineKind: kind === "adjustment",
      createdAt: false,
    },
  });
  const table = (
    <>
      <RTable
        table={list.table}
        isLoading={list.isLoading}
        error={list.error}
        timing={list.timing}
        sizingKey={`expense:purchase-detail:${kind}`}
        ariaLabel={
          kind === "principal"
            ? "Purchase principal expenses"
            : "Purchase receipt adjustments"
        }
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
  return kind === "principal" ? (
    <ExpenseProductImages rows={list.data}>{table}</ExpenseProductImages>
  ) : (
    table
  );
}
