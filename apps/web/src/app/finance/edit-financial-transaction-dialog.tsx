import type { FinancialTransactionOut } from "@cubby/schemas/financial-transaction";
import {
  financialTransactionKind,
  financialTransactionStatus,
} from "@cubby/schemas/financial-transaction";
import { useMemo } from "react";
import { z } from "zod";
import { NullableTextareaField } from "~/app/_components/form-utils";
import { EntityValueField } from "~/app/_components/form-utils/entity-value-field";
import { QuickAddDialog } from "~/app/_components/forms/quick-add-dialog";
import { useTRPC } from "~/integrations/trpc/react";
import { financialTransactionMutationInvalidateKeys } from "~/lib/query-keys";
import {
  SelectField,
  SourceRefsField,
  TextField,
} from "./financial-form-fields";
import {
  WithFinancialAccountSearch,
  WithPurchaseSearch,
} from "./financial-selectors";

const schema = z.object({
  accountId: z.string().min(1),
  purchaseId: z.string(),
  kind: financialTransactionKind,
  status: financialTransactionStatus,
  amount: z
    .number()
    .finite()
    .refine((n) => n !== 0),
  transactionDate: z.string(),
  postedDate: z.string(),
  merchant: z.string(),
  rawDescription: z.string(),
  sourceCategory: z.string(),
  sourceRefs: z.array(z.object({ source: z.string(), externalId: z.string() })),
  notes: z.string(),
});
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
    () => ({
      accountId: transaction.accountId,
      purchaseId: transaction.purchaseId ?? "",
      kind: transaction.kind,
      status: transaction.status,
      amount: transaction.amount,
      transactionDate: transaction.transactionDate ?? "",
      postedDate: transaction.postedDate ?? "",
      merchant: transaction.merchant ?? "",
      rawDescription: transaction.rawDescription ?? "",
      sourceCategory: transaction.sourceCategory ?? "",
      sourceRefs: transaction.sourceRefs,
      notes: transaction.notes ?? "",
    }),
    [transaction],
  );
  return (
    <QuickAddDialog
      open={open}
      onOpenChange={onOpenChange}
      schema={schema}
      defaultValues={defaults}
      title="Edit Transaction"
      description="References replace the complete evidence list. Preserve previous statement references when appending new evidence."
      mutationFn={api.financialTransaction.update.mutationOptions}
      successMessage="Transaction updated"
      invalidateKeys={financialTransactionMutationInvalidateKeys}
      buildPayload={(v) => ({
        id: transaction.id,
        data: {
          ...v,
          purchaseId: v.purchaseId || null,
          transactionDate: v.transactionDate || null,
          postedDate: v.postedDate || null,
          merchant: v.merchant.trim() || null,
          rawDescription: v.rawDescription.trim() || null,
          sourceCategory: v.sourceCategory.trim() || null,
          notes: v.notes.trim() || null,
          sourceRefs: v.sourceRefs.filter(
            (r) => r.source.trim() && r.externalId.trim(),
          ),
        },
      })}
    >
      {(form) => (
        <>
          <EntityValueField
            form={form}
            name="accountId"
            entity="financialAccount"
            label="Account"
            SearchProvider={WithFinancialAccountSearch}
          />
          <EntityValueField
            form={form}
            name="purchaseId"
            entity="purchase"
            label="Purchase"
            SearchProvider={WithPurchaseSearch}
            clearable
          />
          <SelectField
            form={form}
            name="kind"
            label="Kind"
            values={[
              "purchase",
              "refund",
              "account_transfer",
              "credit_card_payment",
              "fee",
              "interest",
              "income",
              "adjustment",
              "other",
            ]}
          />
          <SelectField
            form={form}
            name="status"
            label="Status"
            values={["expected", "pending", "posted", "void"]}
          />
          <TextField form={form} name="amount" label="Amount" type="number" />
          <TextField
            form={form}
            name="transactionDate"
            label="Transaction date"
            type="date"
          />
          <TextField
            form={form}
            name="postedDate"
            label="Posted date"
            type="date"
          />
          <TextField form={form} name="merchant" label="Merchant" />
          <TextField
            form={form}
            name="rawDescription"
            label="Statement description"
          />
          <TextField
            form={form}
            name="sourceCategory"
            label="Source category"
          />
          <SourceRefsField form={form} />
          <NullableTextareaField
            form={form}
            name="notes"
            label="Notes"
            placeholder="Optional evidence"
          />
        </>
      )}
    </QuickAddDialog>
  );
}
