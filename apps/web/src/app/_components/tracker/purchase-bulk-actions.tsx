import type { CostType, PurchaseOut, Trade } from "@cubby/schemas/project";
import type { Row } from "@tanstack/react-table";
import { ArrowRightLeft, Tag, Wrench } from "lucide-react";
import { useMemo, useState } from "react";
import { tradeOptions } from "~/app/projects/trade-options";
import { costTypeOptions } from "~/app/purchases/purchase-options";
import { useTRPC } from "~/integrations/trpc/react";
import { purchaseMutationInvalidateKeys } from "~/lib/query-keys";
import { savedWithBackgroundWork } from "~/lib/recompute-summary";
import type {
  BulkAction,
  BulkActionsConfig,
} from "../data-table/bulk-actions.types";
import { useActionMutation } from "../hooks/useActionMutation";
import { MoveToProjectDialog } from "./move-to-project-dialog";
import { SetFieldDialog } from "./set-field-dialog";

const NO_EXTRA_ACTIONS: BulkAction<PurchaseOut>[] = [];

export function usePurchaseBulkActions({
  extraActions = NO_EXTRA_ACTIONS,
}: {
  extraActions?: BulkAction<PurchaseOut>[];
} = {}) {
  const [moveItems, setMoveItems] = useState<PurchaseOut[]>([]);
  const [tradeItems, setTradeItems] = useState<PurchaseOut[]>([]);
  const [costTypeItems, setCostTypeItems] = useState<PurchaseOut[]>([]);

  const config = useMemo<BulkActionsConfig<PurchaseOut>>(
    () => ({
      actions: [
        {
          id: "move",
          label: "Move to project...",
          icon: <ArrowRightLeft className="size-4" />,
          minSelection: 1,
          onExecute: async (rows: Row<PurchaseOut>[]) => {
            setMoveItems(rows.map((row) => row.original));
            return { success: true };
          },
        },
        {
          id: "set-trade",
          label: "Set trade...",
          icon: <Wrench className="size-4" />,
          minSelection: 1,
          onExecute: async (rows: Row<PurchaseOut>[]) => {
            setTradeItems(rows.map((row) => row.original));
            return { success: true };
          },
        },
        {
          id: "set-cost-type",
          label: "Set cost type...",
          icon: <Tag className="size-4" />,
          minSelection: 1,
          onExecute: async (rows: Row<PurchaseOut>[]) => {
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

export type PurchaseBulkActionsController = ReturnType<
  typeof usePurchaseBulkActions
>;

export function PurchaseBulkActionDialogs({
  controller,
  onComplete,
}: {
  controller: PurchaseBulkActionsController;
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
        `${verb} ${data.items.length} purchase${data.items.length !== 1 ? "s" : ""}`,
      );

  const moveMutation = useActionMutation({
    mutationFn: api.purchase.bulkMove.mutationOptions,
    invalidateKeys: purchaseMutationInvalidateKeys,
    success: resultMessage("Moved"),
    onSuccess: () => {
      setMoveItems([]);
      onComplete();
    },
  });
  const tradeMutation = useActionMutation({
    mutationFn: api.purchase.bulkSetTrade.mutationOptions,
    invalidateKeys: purchaseMutationInvalidateKeys,
    success: resultMessage("Updated"),
    onSuccess: () => {
      setTradeItems([]);
      onComplete();
    },
  });
  const costTypeMutation = useActionMutation({
    mutationFn: api.purchase.bulkSetCostType.mutationOptions,
    invalidateKeys: purchaseMutationInvalidateKeys,
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
          entityLabel="Purchase"
          isPending={moveMutation.isPending}
          onConfirm={async (projectId) => {
            await moveMutation.mutateAsync({
              ids: moveItems.map((purchase) => purchase.id),
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
          itemNoun="Purchase"
          onConfirm={async (trade) => {
            await tradeMutation.mutateAsync({
              ids: tradeItems.map((purchase) => purchase.id),
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
          itemNoun="Purchase"
          onConfirm={async (costType) => {
            await costTypeMutation.mutateAsync({
              ids: costTypeItems.map((purchase) => purchase.id),
              costType: costType as CostType,
            });
          }}
        />
      )}
    </>
  );
}
