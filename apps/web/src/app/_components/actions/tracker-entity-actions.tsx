import {
  parseShortcodeFor,
  type TaskShortcode,
} from "@cubby/schemas/identifiers";
import {
  costTypeSchema,
  type ExpenseOut,
  expenseOut,
  taskStatusSchema,
  tradeSchema,
} from "@cubby/schemas/project";
import { useCallback, useRef, useState } from "react";

import { costTypeOptions } from "~/app/expenses/expense-options";
import { SettleExpenseDialog } from "~/app/expenses/settle-expense-dialog";
import { tradeOptions } from "~/app/projects/trade-options";
import { CreateProjectFromTasksDialog } from "~/app/tasks/create-project-from-tasks-dialog";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import { savedWithBackgroundWork } from "~/lib/recompute-summary";

import { useActionMutation } from "../hooks/useActionMutation";
import { useUpdateMutation } from "../hooks/useUpdateMutation";
import { MoveToProjectDialog } from "../tracker/move-to-project-dialog";
import { SetDueDateDialog } from "../tracker/set-due-date-dialog";
import { SetFieldDialog } from "../tracker/set-field-dialog";
import { SetTaskStatusDialog } from "../tracker/set-task-status-dialog";
import { VerbMenuItem } from "./action-verb-ui";
import type {
  EntityActionHandles,
  EntityActionResolutionContext,
  EntityActionRow,
} from "./entity-actions";
import type { TrackerEntity } from "./tracker-entities";
type StageSource = "row" | "catalog";

interface TrackerActionRow extends EntityActionRow {
  name: string;
  projectId?: string | null;
  projectName?: string | null;
  trade?: string | null;
  costType?: string | null;
  status?: string;
  dueDate?: string | null;
  dueEndDate?: string | null;
}

const asTrackerRow = (row: EntityActionRow): TrackerActionRow => ({
  ...row,
  name: row.name || row.id,
});

function useStagedRows() {
  const [items, setItems] = useState<TrackerActionRow[]>([]);
  const [source, setSource] = useState<StageSource>("catalog");
  const resolveRef = useRef<((result: { success: boolean }) => void) | null>(
    null,
  );

  const stage = useCallback(
    (rows: readonly EntityActionRow[], nextSource: StageSource) => {
      resolveRef.current?.({ success: false });
      setItems(rows.map(asTrackerRow));
      setSource(nextSource);
      return new Promise<{ success: boolean }>((resolve) => {
        resolveRef.current = resolve;
      });
    },
    [],
  );

  const close = useCallback((success: boolean) => {
    setItems([]);
    resolveRef.current?.({ success });
    resolveRef.current = null;
  }, []);

  return {
    items,
    source,
    stage,
    cancel: () => close(false),
    complete: () => close(true),
  };
}

const expenseBulkUpdate = entityMutationOptionsFactory("expense", "bulkUpdate");
const taskBulkUpdate = entityMutationOptionsFactory("task", "bulkUpdate");

const countLabel = (entity: TrackerEntity, count: number) =>
  `${count} ${entity}${count === 1 ? "" : "s"}`;

function useTrackerBulkMutation(
  entity: TrackerEntity,
  successVerb = "Updated",
) {
  const expense = useActionMutation({
    mutationFn: expenseBulkUpdate,
    success: (data) =>
      savedWithBackgroundWork(
        data.sideEffects,
        `${successVerb} ${countLabel("expense", data.updated)}`,
      ),
  });
  const task = useActionMutation({
    mutationFn: taskBulkUpdate,
    success: (data) =>
      savedWithBackgroundWork(
        data.sideEffects,
        `${successVerb} ${countLabel("task", data.updated)}`,
      ),
  });
  return entity === "expense" ? expense : task;
}

const rowMenuItem = (
  verb:
    | "moveToProject"
    | "setTrade"
    | "setCostType"
    | "setStatus"
    | "setDueDate",
  row: EntityActionRow,
  stage: ReturnType<typeof useStagedRows>["stage"],
) => (
  <VerbMenuItem
    verb={verb}
    onSelect={(event) => {
      event.stopPropagation();
      void stage([row], "row");
    }}
  />
);

export function useMoveToProjectEntityAction(
  trackerEntity: TrackerEntity,
): EntityActionHandles {
  const staged = useStagedRows();
  const bulkMutation = useTrackerBulkMutation(trackerEntity, "Moved");
  const expenseUpdate = useUpdateMutation({
    mutationFn: entityMutationOptionsFactory("expense", "update"),
    entity: "expense",
  });
  const isPending =
    bulkMutation.isPending ||
    (trackerEntity === "expense" && expenseUpdate.isPending);

  return {
    run: (rows) => staged.stage(rows, "catalog"),
    rowMenuItem: (row) => rowMenuItem("moveToProject", row, staged.stage),
    dialog: staged.items.length > 0 && (
      <MoveToProjectDialog
        open
        onOpenChange={(open) => {
          if (!open) staged.cancel();
        }}
        items={staged.items}
        entityLabel={trackerEntity === "expense" ? "Expense" : "Task"}
        currentProject={(item) =>
          item.projectId
            ? {
                id: parseShortcodeFor("project", item.projectId),
                name: item.projectName ?? item.projectId,
              }
            : null
        }
        isPending={isPending}
        onConfirm={async (projectId) => {
          const [sole] = staged.items;
          if (trackerEntity === "expense" && staged.source === "row" && sole) {
            await expenseUpdate.mutateAsync({
              id: parseShortcodeFor("expense", sole.id),
              data: { projectId },
            });
          } else if (trackerEntity === "expense") {
            await bulkMutation.mutateAsync({
              ids: staged.items.map((item) =>
                parseShortcodeFor("expense", item.id),
              ),
              data: { projectId },
            });
          } else {
            await bulkMutation.mutateAsync({
              ids: staged.items.map((item) =>
                parseShortcodeFor("task", item.id),
              ),
              data: { projectId },
            });
          }
          staged.complete();
        }}
      />
    ),
  };
}

export function useSetTradeEntityAction(
  trackerEntity: TrackerEntity,
): EntityActionHandles {
  const staged = useStagedRows();
  const mutation = useTrackerBulkMutation(trackerEntity);
  return {
    run: (rows) => staged.stage(rows, "catalog"),
    rowMenuItem: (row) => rowMenuItem("setTrade", row, staged.stage),
    dialog: staged.items.length > 0 && (
      <SetFieldDialog
        open
        onOpenChange={(open) => {
          if (!open) staged.cancel();
        }}
        items={staged.items}
        isPending={mutation.isPending}
        currentValue={(item) => item.trade ?? null}
        options={tradeOptions}
        fieldLabel="Trade"
        itemNoun={trackerEntity === "expense" ? "Expense" : "Task"}
        onConfirm={async (trade) => {
          if (trackerEntity === "expense") {
            await mutation.mutateAsync({
              ids: staged.items.map((item) =>
                parseShortcodeFor("expense", item.id),
              ),
              data: { trade: tradeSchema.parse(trade) },
            });
          } else {
            await mutation.mutateAsync({
              ids: staged.items.map((item) =>
                parseShortcodeFor("task", item.id),
              ),
              data: { trade: tradeSchema.parse(trade) },
            });
          }
          staged.complete();
        }}
      />
    ),
  };
}

export function useSetExpenseCostTypeAction(): EntityActionHandles {
  const staged = useStagedRows();
  const mutation = useTrackerBulkMutation("expense");
  return {
    run: (rows) => staged.stage(rows, "catalog"),
    rowMenuItem: (row) => rowMenuItem("setCostType", row, staged.stage),
    dialog: staged.items.length > 0 && (
      <SetFieldDialog
        open
        onOpenChange={(open) => {
          if (!open) staged.cancel();
        }}
        items={staged.items}
        isPending={mutation.isPending}
        currentValue={(item) => item.costType ?? null}
        options={costTypeOptions}
        fieldLabel="Cost Type"
        itemNoun="Expense"
        onConfirm={async (costType) => {
          await mutation.mutateAsync({
            ids: staged.items.map((item) =>
              parseShortcodeFor("expense", item.id),
            ),
            data: { costType: costTypeSchema.parse(costType) },
          });
          staged.complete();
        }}
      />
    ),
  };
}

export function useSetTaskStatusAction(): EntityActionHandles {
  const staged = useStagedRows();
  const mutation = useTrackerBulkMutation("task");
  return {
    run: (rows) => staged.stage(rows, "catalog"),
    rowMenuItem: (row) => rowMenuItem("setStatus", row, staged.stage),
    dialog: staged.items.length > 0 && (
      <SetTaskStatusDialog
        open
        onOpenChange={(open) => {
          if (!open) staged.cancel();
        }}
        items={staged.items}
        currentStatus={(item) => taskStatusSchema.parse(item.status)}
        isPending={mutation.isPending}
        onConfirm={async (status) => {
          await mutation.mutateAsync({
            ids: staged.items.map((item) => parseShortcodeFor("task", item.id)),
            data: { status },
          });
          staged.complete();
        }}
      />
    ),
  };
}

export function useSetTaskDueDateAction(): EntityActionHandles {
  const staged = useStagedRows();
  const mutation = useTrackerBulkMutation("task");
  return {
    run: (rows) => staged.stage(rows, "catalog"),
    rowMenuItem: (row) => rowMenuItem("setDueDate", row, staged.stage),
    dialog: staged.items.length > 0 && (
      <SetDueDateDialog
        open
        onOpenChange={(open) => {
          if (!open) staged.cancel();
        }}
        items={staged.items}
        currentWindow={(item) => ({
          dueDate: item.dueDate ?? null,
          dueEndDate: item.dueEndDate ?? null,
        })}
        isPending={mutation.isPending}
        onConfirm={async (dueDate, dueEndDate) => {
          await mutation.mutateAsync({
            ids: staged.items.map((item) => parseShortcodeFor("task", item.id)),
            data: { dueDate, dueEndDate },
          });
          staged.complete();
        }}
      />
    ),
  };
}

const ALREADY_PURCHASED = "Already purchased";
const ADJUSTMENT_NOT_CLASSIFIED = "Adjustments aren't classified";

const asExpense = (row: EntityActionRow): ExpenseOut | null => {
  const parsed = expenseOut.safeParse(row);
  return parsed.success ? parsed.data : null;
};

export function useMarkExpensePurchasedAction(): EntityActionHandles {
  const [target, setTarget] = useState<ExpenseOut | null>(null);
  const disabledReason = (expense: ExpenseOut) =>
    expense.lineKind !== "principal"
      ? ADJUSTMENT_NOT_CLASSIFIED
      : expense.future
        ? undefined
        : ALREADY_PURCHASED;
  const availability = ({ rows }: EntityActionResolutionContext) => {
    const expense = rows[0] ? asExpense(rows[0]) : null;
    if (!expense) return { status: "hidden" } as const;
    const reason = disabledReason(expense);
    return reason
      ? ({ status: "disabled", reason } as const)
      : ({ status: "available" } as const);
  };
  return {
    run: async (rows) => {
      const expense = rows[0] ? asExpense(rows[0]) : null;
      if (!expense || disabledReason(expense)) return { success: false };
      setTarget(expense);
      return { success: true };
    },
    availability,
    rowMenuItem: (row) => {
      const expense = asExpense(row);
      if (!expense) return null;
      return (
        <VerbMenuItem
          verb="markPurchased"
          disabledReason={disabledReason(expense)}
          onSelect={(event) => {
            event.stopPropagation();
            setTarget(expense);
          }}
        />
      );
    },
    dialog: target && (
      <SettleExpenseDialog
        open
        onOpenChange={(open) => {
          if (!open) setTarget(null);
        }}
        expense={target}
      />
    ),
  };
}

export function useCreateProjectFromTasksAction(): EntityActionHandles {
  const [taskIds, setTaskIds] = useState<TaskShortcode[]>([]);
  return {
    run: async (rows) => {
      setTaskIds(rows.map((row) => parseShortcodeFor("task", row.id)));
      return { success: true };
    },
    rowMenuItem: () => null,
    dialog: taskIds.length > 0 && (
      <CreateProjectFromTasksDialog
        open
        onOpenChange={(open) => {
          if (!open) setTaskIds([]);
        }}
        taskIds={taskIds}
      />
    ),
  };
}
