import { fieldValueOf } from "@cubby/schemas/field-envelope";
import { useState } from "react";

import { VerbButton } from "~/entity/actions/action-verb-ui";
import type { SectionActionComponent } from "~/entity/entity-detail/section-actions";

import { ReceiveExpenseDialog } from "./receive-expense-dialog";
import { SplitExpenseDialog } from "./split-expense-dialog";

/**
 * Splitting files the parts under the expense's purchase; the server leaves the verb
 * unavailable (with its reason) until the expense has one.
 */
export const SplitExpenseAction: SectionActionComponent<"expense"> = ({
  record: expense,
  action,
}) => {
  const effectiveExpensePurchaseId = fieldValueOf(expense.fields.purchaseId);

  const [open, setOpen] = useState(false);
  return (
    <>
      <VerbButton
        verb="split"
        disabledReason={action.disabledReason ?? undefined}
        onClick={() => setOpen(true)}
      />
      {effectiveExpensePurchaseId ? (
        <SplitExpenseDialog
          open={open}
          onOpenChange={setOpen}
          expense={expense}
          purchaseShortcode={effectiveExpensePurchaseId}
        />
      ) : null}
    </>
  );
};

/**
 * Receiving is deliberately a separate, explicit act — linking a product records what was bought,
 * it never moves inventory on its own (README tenet: inventory never auto-decrements).
 */
export const ReceiveExpenseAction: SectionActionComponent<"expense"> = ({
  record: expense,
  action,
}) => {
  const effectiveExpenseProductId = fieldValueOf(expense.fields.productId);

  const [open, setOpen] = useState(false);
  return (
    <>
      <VerbButton
        verb="receive"
        // `VerbButton` disables on any non-null reason, so pass one only when the server gives it.
        disabledReason={action.disabledReason ?? undefined}
        onClick={() => setOpen(true)}
      />
      {effectiveExpenseProductId ? (
        <ReceiveExpenseDialog
          open={open}
          onOpenChange={setOpen}
          productId={effectiveExpenseProductId}
          productName={expense.productName ?? effectiveExpenseProductId}
          expenseName={expense.name}
          expenseId={expense.id}
        />
      ) : null}
    </>
  );
};
