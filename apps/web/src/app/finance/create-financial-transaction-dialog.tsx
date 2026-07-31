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
  accountId: z.string().min(1, "Account shortcode is required"),
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
export function CreateFinancialTransactionDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const api = useTRPC();
  const defaults = useMemo<z.infer<typeof schema>>(
    () => ({
      accountId: "",
      purchaseId: "",
      kind: "purchase" as const,
      status: "pending" as const,
      amount: 0,
      transactionDate: "",
      postedDate: "",
      merchant: "",
      rawDescription: "",
      sourceCategory: "",
      sourceRefs: [],
      notes: "",
    }),
    [],
  );
  return (
    <QuickAddDialog
      open={open}
      onOpenChange={onOpenChange}
      schema={schema}
      defaultValues={defaults}
      title="New Transaction"
      description="Settlement evidence only. Amounts never change expense spend or project budgets."
      mutationFn={api.financialTransaction.create.mutationOptions}
      successMessage="Transaction created"
      invalidateKeys={financialTransactionMutationInvalidateKeys}
      buildPayload={(v) => ({
        ...v,
        purchaseId: v.purchaseId.trim() || null,
        transactionDate: v.transactionDate || null,
        postedDate: v.postedDate || null,
        merchant: v.merchant.trim() || null,
        rawDescription: v.rawDescription.trim() || null,
        sourceCategory: v.sourceCategory.trim() || null,
        notes: v.notes.trim() || null,
        sourceRefs: v.sourceRefs.filter(
          (r) => r.source.trim() && r.externalId.trim(),
        ),
      })}
    >
      {(form) => (
        <>
          <EntityValueField
            form={form}
            name="accountId"
            entity="financialAccount"
            label="Account"
            placeholder="Select account"
            SearchProvider={WithFinancialAccountSearch}
          />
          <EntityValueField
            form={form}
            name="purchaseId"
            entity="purchase"
            label="Purchase"
            placeholder="Optional linked purchase"
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
