import {
  parseShortcodeFor,
  type TaskShortcode,
} from "@cubby/schemas/identifiers";
import { type ExpenseOut, expenseOut } from "@cubby/schemas/project";
import { useState } from "react";

import { CreateProjectFromTasksDialog } from "~/app/tasks/create-project-from-tasks-dialog";
import { EntityEditDialog } from "~/entities/editing/entity-edit-dialog";

import { VerbMenuItem } from "./action-verb-ui";
import type {
  EntityActionHandles,
  EntityActionResolutionContext,
  EntityActionRow,
} from "./entity-actions";

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
      <EntityEditDialog
        open
        onOpenChange={(open) => {
          if (!open) setTarget(null);
        }}
        request={{
          entity: "expense",
          operation: "update",
          intent: "settle",
          record: target,
        }}
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
