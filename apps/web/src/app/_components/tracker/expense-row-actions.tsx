/**
 * The row-menu counterpart to {@link useExpenseBulkActions}: settle a planned
 * expense, or move one to a project, without leaving the table.
 *
 * ## Why this is shared
 *
 * The logic used to live inline in `expenselist.tsx` as the only copy, so the
 * four embedded expense tables — project data lists, project detail, purchase
 * detail, product detail — offered the bulk versions of both operations and no
 * row version at all. Selecting a single row to move it is a strange way to
 * move one row.
 *
 * Reschedule and change-estimate are deliberately absent: the Date and Cost
 * columns are already inline-editable everywhere this renders.
 *
 * ## Why unavailable actions are disabled rather than hidden
 *
 * Both verbs are meaningful on some rows and not others, and which is which
 * differs per table. An item that silently disappears is indistinguishable from
 * one that was never built, so an inapplicable verb stays listed and says why —
 * see `VerbMenuItem`'s `disabledReason`.
 *
 * Gating is keyed on the ROW (and the table), never the current view: the same
 * expense must offer the same actions whichever filters got you to it.
 */

import type { ExpenseOut } from "@cubby/schemas/project";
import { useCallback, useState } from "react";
import { SettleExpenseDialog } from "~/app/expenses/settle-expense-dialog";
import { useTRPC } from "~/integrations/trpc/react";
import { VerbMenuItem } from "../actions/action-verb-ui";
import { useUpdateMutation } from "../hooks/useUpdateMutation";
import { MoveToProjectDialog } from "./move-to-project-dialog";

/** A booked expense has already happened; there is nothing left to settle. */
const ALREADY_PURCHASED = "Already purchased";

export function useExpenseRowActions({
  moveDisabledReason,
  settleDisabledReason,
}: {
  /**
   * Blanket reason the move does not apply in this table — e.g. a leaf
   * project's own expense list, where every row is already in this project.
   */
  moveDisabledReason?: string;
  /**
   * Blanket reason settling does not apply in this table, checked ahead of the
   * per-row `future` test because it is the more categorical fact.
   */
  settleDisabledReason?: string;
} = {}) {
  const api = useTRPC();
  const [moveTarget, setMoveTarget] = useState<ExpenseOut | null>(null);
  const [settleTarget, setSettleTarget] = useState<ExpenseOut | null>(null);

  // Singular `update`, not the bulk `bulkMove` the selection bar uses: one row,
  // one mutation, and the optimistic path that comes with it.
  const moveMutation = useUpdateMutation({
    mutationFn: api.expense.update.mutationOptions,
    entity: "expense",
  });

  const extraActions = useCallback(
    (row: ExpenseOut) => (
      <>
        <VerbMenuItem
          verb="markPurchased"
          disabledReason={
            settleDisabledReason ?? (row.future ? undefined : ALREADY_PURCHASED)
          }
          onSelect={(e) => {
            e.stopPropagation();
            setSettleTarget(row);
          }}
        />
        {/* Not gated on `future`. The bulk counterpart never was, so a booked
            expense could always be re-projected by selecting it — the row menu
            was the lone holdout, and re-projecting settled spend is routine. */}
        <VerbMenuItem
          verb="moveToProject"
          disabledReason={moveDisabledReason}
          onSelect={(e) => {
            e.stopPropagation();
            setMoveTarget(row);
          }}
        />
      </>
    ),
    [moveDisabledReason, settleDisabledReason],
  );

  const dialogs = (
    <>
      {moveTarget && (
        <MoveToProjectDialog
          open
          onOpenChange={(open) => {
            if (!open) setMoveTarget(null);
          }}
          items={[moveTarget]}
          entityLabel="Expense"
          isPending={moveMutation.isPending}
          onConfirm={async (projectId) => {
            await moveMutation.mutateAsync({
              id: moveTarget.id,
              data: { projectId },
            });
            setMoveTarget(null);
          }}
        />
      )}
      {settleTarget && (
        <SettleExpenseDialog
          open
          onOpenChange={(open) => {
            if (!open) setSettleTarget(null);
          }}
          expense={settleTarget}
        />
      )}
    </>
  );

  return { extraActions, dialogs };
}
