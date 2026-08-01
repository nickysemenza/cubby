import { useMemo } from "react";
import { QuickAddDialog } from "~/app/_components/forms/quick-add-dialog";
import { useTRPC } from "~/integrations/trpc/react";
import { financialTransactionMutationInvalidateKeys } from "~/lib/query-keys";
import {
  emptyFinancialTransactionForm,
  FinancialTransactionFormFields,
  type FinancialTransactionFormValues,
  financialTransactionFormSchema,
  normalizeFinancialTransactionForm,
} from "./financial-transaction-form";
export function CreateFinancialTransactionDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const api = useTRPC();
  const defaults = useMemo<FinancialTransactionFormValues>(
    () => ({ ...emptyFinancialTransactionForm }),
    [],
  );
  return (
    <QuickAddDialog
      open={open}
      onOpenChange={onOpenChange}
      schema={financialTransactionFormSchema}
      defaultValues={defaults}
      title="New Transaction"
      description="Settlement evidence only. Amounts never change expense spend or project budgets."
      mutationFn={api.financialTransaction.create.mutationOptions}
      successMessage="Transaction created"
      invalidateKeys={financialTransactionMutationInvalidateKeys}
      buildPayload={normalizeFinancialTransactionForm}
    >
      {(form) => <FinancialTransactionFormFields form={form} />}
    </QuickAddDialog>
  );
}
