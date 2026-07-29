import type { CostType, ExpenseOut, Trade } from "@cubby/schemas/project";
import type { Row } from "@tanstack/react-table";
import { ArrowRightLeft, Tag, Wrench } from "lucide-react";
import { useMemo, useState } from "react";
import { costTypeOptions } from "~/app/expenses/expense-options";
import { tradeOptions } from "~/app/projects/trade-options";
import { useTRPC } from "~/integrations/trpc/react";
import { expenseMutationInvalidateKeys } from "~/lib/query-keys";
import { savedWithBackgroundWork } from "~/lib/recompute-summary";
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
        {
          id: "move",
          label: "Move to project...",
          icon: <ArrowRightLeft className="size-4" />,
          minSelection: 1,
          onExecute: async (rows: Row<ExpenseOut>[]) => {
            setMoveItems(rows.map((row) => row.original));
            return { success: true };
          },
        },
        {
          id: "set-trade",
          label: "Set trade...",
          icon: <Wrench className="size-4" />,
          minSelection: 1,
          onExecute: async (rows: Row<ExpenseOut>[]) => {
            setTradeItems(rows.map((row) => row.original));
            return { success: true };
          },
        },
        {
          id: "set-cost-type",
          label: "Set cost type...",
          icon: <Tag className="size-4" />,
          minSelection: 1,
          onExecute: async (rows: Row<ExpenseOut>[]) => {
            setCostTypeItems(rows.map((row) => row.original));
            return { success: true };
          },
        },
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
  const api = useTRPC();
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
    mutationFn: api.expense.bulkMove.mutationOptions,
    invalidateKeys: expenseMutationInvalidateKeys,
    success: resultMessage("Moved"),
    onSuccess: () => {
      setMoveItems([]);
      onComplete();
    },
  });
  const tradeMutation = useActionMutation({
    mutationFn: api.expense.bulkSetTrade.mutationOptions,
    invalidateKeys: expenseMutationInvalidateKeys,
    success: resultMessage("Updated"),
    onSuccess: () => {
      setTradeItems([]);
      onComplete();
    },
  });
  const costTypeMutation = useActionMutation({
    mutationFn: api.expense.bulkSetCostType.mutationOptions,
    invalidateKeys: expenseMutationInvalidateKeys,
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
