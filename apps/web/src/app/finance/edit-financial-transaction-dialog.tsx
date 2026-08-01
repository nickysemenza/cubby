import type { FinancialTransactionOut } from "@cubby/schemas/financial-transaction";
import { useMemo } from "react";
import { QuickAddDialog } from "~/app/_components/forms/quick-add-dialog";
import { useTRPC } from "~/integrations/trpc/react";
import { financialTransactionMutationInvalidateKeys } from "~/lib/query-keys";
import {
  FinancialTransactionFormFields,
  financialTransactionFormSchema,
  financialTransactionToForm,
  normalizeFinancialTransactionForm,
} from "./financial-transaction-form";
export function EditFinancialTransactionDialog({
  transaction,
  open,
  onOpenChange,
}: {
  transaction: FinancialTransactionOut;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const api = useTRPC();
  const defaults = useMemo(
    () => financialTransactionToForm(transaction),
    [transaction],
  );
  return (
    <QuickAddDialog
      open={open}
      onOpenChange={onOpenChange}
      schema={financialTransactionFormSchema}
      defaultValues={defaults}
      title="Edit Transaction"
      description="References replace the complete evidence list. Preserve previous statement references when appending new evidence."
      mutationFn={api.financialTransaction.update.mutationOptions}
      successMessage="Transaction updated"
      invalidateKeys={financialTransactionMutationInvalidateKeys}
      buildPayload={(v) => ({
        id: transaction.id,
        data: normalizeFinancialTransactionForm(v),
      })}
    >
      {(form) => <FinancialTransactionFormFields form={form} />}
    </QuickAddDialog>
  );
}
