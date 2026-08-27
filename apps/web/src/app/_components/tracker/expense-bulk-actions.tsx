import type { CostType, ExpenseOut, Trade } from "@cubby/schemas/project";
import { useMemo } from "react";
import { costTypeOptions } from "~/app/expenses/expense-options";
import { tradeOptions } from "~/app/projects/trade-options";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import { savedWithBackgroundWork } from "~/lib/recompute-summary";
import type {
  BulkAction,
  BulkActionsConfig,
} from "../data-table/bulk-actions.types";
import { useStagedBulkAction } from "../hooks/useStagedBulkAction";
import { MoveToProjectDialog } from "./move-to-project-dialog";
import { SetFieldDialog } from "./set-field-dialog";

const NO_EXTRA_ACTIONS: BulkAction<ExpenseOut>[] = [];

/**
 * Every expense bulk verb here is one kernel `bulkUpdate` over a declared
 * field mask — the id set differs, the patch differs, the command does not.
 */
const expenseBulkUpdateOptions = entityMutationOptionsFactory(
  "expense",
  "bulkUpdate",
);

export function useExpenseBulkActions({
  extraActions = NO_EXTRA_ACTIONS,
}: {
  extraActions?: BulkAction<ExpenseOut>[];
} = {}) {
  const expenseCount = (data: { updated: number }) =>
    `${data.updated} expense${data.updated !== 1 ? "s" : ""}`;
  const updated = (data: {
    updated: number;
    sideEffects: Parameters<typeof savedWithBackgroundWork>[0];
  }) =>
    savedWithBackgroundWork(data.sideEffects, `Updated ${expenseCount(data)}`);

  const move = useStagedBulkAction<ExpenseOut, typeof expenseBulkUpdateOptions>(
    {
      verb: "moveToProject",
      // The existing id is load-bearing: layouts persist per action id.
      id: "move",
      mutationFn: expenseBulkUpdateOptions,
      success: (data) =>
        savedWithBackgroundWork(
          data.sideEffects,
          `Moved ${expenseCount(data)}`,
        ),
    },
  );
  const trade = useStagedBulkAction<
    ExpenseOut,
    typeof expenseBulkUpdateOptions
  >({
    verb: "setTrade",
    mutationFn: expenseBulkUpdateOptions,
    success: updated,
  });
  const costType = useStagedBulkAction<
    ExpenseOut,
    typeof expenseBulkUpdateOptions
  >({
    verb: "setCostType",
    mutationFn: expenseBulkUpdateOptions,
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
          currentProject={(item) =>
            item.projectId
              ? { id: item.projectId, name: item.projectName ?? item.projectId }
              : null
          }
          isPending={move.isPending}
          onConfirm={async (projectId) => {
            await move.submit({ data: { projectId } });
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
          currentValue={(item) => item.trade}
          options={tradeOptions}
          fieldLabel="Trade"
          itemNoun="Expense"
          onConfirm={async (nextTrade) => {
            await trade.submit({ data: { trade: nextTrade as Trade } });
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
          currentValue={(item) => item.costType}
          options={costTypeOptions}
          fieldLabel="Cost Type"
          itemNoun="Expense"
          onConfirm={async (nextCostType) => {
            await costType.submit({
              data: { costType: nextCostType as CostType },
            });
            onComplete();
          }}
        />
      )}
    </>
  );
}
