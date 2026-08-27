import type { CostType, ExpenseOut, Trade } from "@cubby/schemas/project";
import { useMemo } from "react";
import { expense } from "~/app/expenses/expense.functions";
import { costTypeOptions } from "~/app/expenses/expense-options";
import { tradeOptions } from "~/app/projects/trade-options";
import { invalidatesFor } from "~/lib/query-keys";
import { savedWithBackgroundWork } from "~/lib/recompute-summary";
import type {
  BulkAction,
  BulkActionsConfig,
} from "../data-table/bulk-actions.types";
import { useStagedBulkAction } from "../hooks/useStagedBulkAction";
import { MoveToProjectDialog } from "./move-to-project-dialog";
import { SetFieldDialog } from "./set-field-dialog";

const NO_EXTRA_ACTIONS: BulkAction<ExpenseOut>[] = [];

export function useExpenseBulkActions({
  extraActions = NO_EXTRA_ACTIONS,
}: {
  extraActions?: BulkAction<ExpenseOut>[];
} = {}) {
  const expenseCount = (data: { items: unknown[] }) =>
    `${data.items.length} expense${data.items.length !== 1 ? "s" : ""}`;
  const updated = (data: {
    items: unknown[];
    sideEffects: Parameters<typeof savedWithBackgroundWork>[0];
  }) =>
    savedWithBackgroundWork(data.sideEffects, `Updated ${expenseCount(data)}`);

  const move = useStagedBulkAction<
    ExpenseOut,
    typeof expense.bulkMove.mutationOptions
  >({
    verb: "moveToProject",
    // The existing id is load-bearing: layouts persist per action id.
    id: "move",
    mutationFn: expense.bulkMove.mutationOptions,
    invalidateKeys: invalidatesFor("expense"),
    success: (data) =>
      savedWithBackgroundWork(data.sideEffects, `Moved ${expenseCount(data)}`),
  });
  const trade = useStagedBulkAction<
    ExpenseOut,
    typeof expense.bulkSetTrade.mutationOptions
  >({
    verb: "setTrade",
    mutationFn: expense.bulkSetTrade.mutationOptions,
    invalidateKeys: invalidatesFor("expense"),
    success: updated,
  });
  const costType = useStagedBulkAction<
    ExpenseOut,
    typeof expense.bulkSetCostType.mutationOptions
  >({
    verb: "setCostType",
    mutationFn: expense.bulkSetCostType.mutationOptions,
    invalidateKeys: invalidatesFor("expense"),
    success: updated,
  });

  const config = useMemo<BulkActionsConfig<ExpenseOut>>(
    () => ({
      actions: [move.action, trade.action, costType.action, ...extraActions],
      clearSelectionOnComplete: false,
    }),
    [extraActions, move.action, trade.action, costType.action],
  );

  return { config, move, trade, costType };
}

export type ExpenseBulkActionsController = ReturnType<
  typeof useExpenseBulkActions
>;

export function ExpenseBulkActionDialogs({
  controller,
  onComplete,
}: {
  controller: ExpenseBulkActionsController;
  /** Runs after a successful write — the surface clears its row selection. */
  onComplete: () => void;
}) {
  const { move, trade, costType } = controller;
  const closed = (staged: { cancel: () => void }) => (open: boolean) => {
    if (!open) staged.cancel();
  };

  return (
    <>
      {move.items.length > 0 && (
        <MoveToProjectDialog
          open
          onOpenChange={closed(move)}
          items={move.items}
          entityLabel="Expense"
          isPending={move.isPending}
          onConfirm={async (projectId) => {
            await move.submit({ projectId });
            onComplete();
          }}
        />
      )}
      {trade.items.length > 0 && (
        <SetFieldDialog
          open
          onOpenChange={closed(trade)}
          items={trade.items}
          isPending={trade.isPending}
          options={tradeOptions}
          fieldLabel="Trade"
          itemNoun="Expense"
          onConfirm={async (nextTrade) => {
            await trade.submit({ trade: nextTrade as Trade });
            onComplete();
          }}
        />
      )}
      {costType.items.length > 0 && (
        <SetFieldDialog
          open
          onOpenChange={closed(costType)}
          items={costType.items}
          isPending={costType.isPending}
          options={costTypeOptions}
          fieldLabel="Cost Type"
          itemNoun="Expense"
          onConfirm={async (nextCostType) => {
            await costType.submit({ costType: nextCostType as CostType });
            onComplete();
          }}
        />
      )}
    </>
  );
}
