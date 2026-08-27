import type { CostType, ExpenseOut, Trade } from "@cubby/schemas/project";
import { useMemo, useState } from "react";
import { expense } from "~/app/expenses/expense.functions";
import { costTypeOptions } from "~/app/expenses/expense-options";
import { tradeOptions } from "~/app/projects/trade-options";
import { savedWithBackgroundWork } from "~/lib/recompute-summary";
import { verbBulkAction } from "../actions/action-verb-ui";
import type {
  BulkAction,
  BulkActionsConfig,
} from "../data-table/bulk-actions.types";
import { useActionMutation } from "../hooks/useActionMutation";
import { MoveToProjectDialog } from "./move-to-project-dialog";
import { SetFieldDialog } from "./set-field-dialog";

const NO_EXTRA_ACTIONS: BulkAction<ExpenseOut>[] = [];

export function useExpenseBulkActions({
  extraActions = NO_EXTRA_ACTIONS,
}: {
  extraActions?: BulkAction<ExpenseOut>[];
} = {}) {
  const [moveItems, setMoveItems] = useState<ExpenseOut[]>([]);
  const [tradeItems, setTradeItems] = useState<ExpenseOut[]>([]);
  const [costTypeItems, setCostTypeItems] = useState<ExpenseOut[]>([]);

  const config = useMemo<BulkActionsConfig<ExpenseOut>>(
    () => ({
      actions: [
        verbBulkAction<ExpenseOut>("moveToProject", {
          id: "move",
          minSelection: 1,
          onExecute: async (rows) => {
            setMoveItems(rows.map((row) => row.original));
            return { success: true };
          },
        }),
        verbBulkAction<ExpenseOut>("setTrade", {
          minSelection: 1,
          onExecute: async (rows) => {
            setTradeItems(rows.map((row) => row.original));
            return { success: true };
          },
        }),
        verbBulkAction<ExpenseOut>("setCostType", {
          minSelection: 1,
          onExecute: async (rows) => {
            setCostTypeItems(rows.map((row) => row.original));
            return { success: true };
          },
        }),
        ...extraActions,
      ],
      clearSelectionOnComplete: false,
    }),
    [extraActions],
  );

  return {
    config,
    moveItems,
    setMoveItems,
    tradeItems,
    setTradeItems,
    costTypeItems,
    setCostTypeItems,
  };
}

export type ExpenseBulkActionsController = ReturnType<
  typeof useExpenseBulkActions
>;

export function ExpenseBulkActionDialogs({
  controller,
  onComplete,
}: {
  controller: ExpenseBulkActionsController;
  onComplete: () => void;
}) {
  const {
    moveItems,
    setMoveItems,
    tradeItems,
    setTradeItems,
    costTypeItems,
    setCostTypeItems,
  } = controller;
  const resultMessage =
    (verb: "Moved" | "Updated") =>
    (data: {
      items: unknown[];
      sideEffects: Parameters<typeof savedWithBackgroundWork>[0];
    }) =>
      savedWithBackgroundWork(
        data.sideEffects,
        `${verb} ${data.items.length} expense${data.items.length !== 1 ? "s" : ""}`,
      );

  const moveMutation = useActionMutation({
    mutationFn: expense.bulkMove.mutationOptions,
    success: resultMessage("Moved"),
    onSuccess: () => {
      setMoveItems([]);
      onComplete();
    },
  });
  const tradeMutation = useActionMutation({
    mutationFn: expense.bulkSetTrade.mutationOptions,
    success: resultMessage("Updated"),
    onSuccess: () => {
      setTradeItems([]);
      onComplete();
    },
  });
  const costTypeMutation = useActionMutation({
    mutationFn: expense.bulkSetCostType.mutationOptions,
    success: resultMessage("Updated"),
    onSuccess: () => {
      setCostTypeItems([]);
      onComplete();
    },
  });

  return (
    <>
      {moveItems.length > 0 && (
        <MoveToProjectDialog
          open
          onOpenChange={(open) => {
            if (!open) setMoveItems([]);
          }}
          items={moveItems}
          entityLabel="Expense"
          isPending={moveMutation.isPending}
          onConfirm={async (projectId) => {
            await moveMutation.mutateAsync({
              ids: moveItems.map((expense) => expense.id),
              projectId,
            });
          }}
        />
      )}
      {tradeItems.length > 0 && (
        <SetFieldDialog
          open
          onOpenChange={(open) => {
            if (!open) setTradeItems([]);
          }}
          items={tradeItems}
          isPending={tradeMutation.isPending}
          options={tradeOptions}
          fieldLabel="Trade"
          itemNoun="Expense"
          onConfirm={async (trade) => {
            await tradeMutation.mutateAsync({
              ids: tradeItems.map((expense) => expense.id),
              trade: trade as Trade,
            });
          }}
        />
      )}
      {costTypeItems.length > 0 && (
        <SetFieldDialog
          open
          onOpenChange={(open) => {
            if (!open) setCostTypeItems([]);
          }}
          items={costTypeItems}
          isPending={costTypeMutation.isPending}
          options={costTypeOptions}
          fieldLabel="Cost Type"
          itemNoun="Expense"
          onConfirm={async (costType) => {
            await costTypeMutation.mutateAsync({
              ids: costTypeItems.map((expense) => expense.id),
              costType: costType as CostType,
            });
          }}
        />
      )}
    </>
  );
}
