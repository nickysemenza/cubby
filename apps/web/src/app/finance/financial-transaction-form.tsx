import {
  financialTransactionKind,
  financialTransactionStatus,
} from "@cubby/schemas/financial-transaction";
import type { UseFormReturn } from "react-hook-form";
import { z } from "zod";

import {
  NullableTextareaField,
  PlainDateField,
} from "~/app/_components/form-utils";
import { EntityValueField } from "~/app/_components/form-utils/entity-value-field";

import {
  SelectField,
  SourceRefsField,
  TextField,
} from "./financial-form-fields";
import {
  WithFinancialAccountSearch,
  WithPurchaseSearch,
} from "./financial-selectors";

export const financialTransactionFormSchema = z
  .object({
    accountId: z.string().min(1, "Account shortcode is required"),
    purchaseId: z.string(),
    kind: financialTransactionKind,
    status: financialTransactionStatus,
    amount: z
      .number()
      .finite()
      .refine((amount) => amount !== 0, "Amount must be non-zero"),
    transactionDate: z.string().nullable(),
    postedDate: z.string().nullable(),
    merchant: z.string(),
    rawDescription: z.string(),
    sourceCategory: z.string(),
    sourceRefs: z.array(
      z.object({ source: z.string(), externalId: z.string() }),
    ),
    notes: z.string(),
  })
  .refine(
    (transaction) =>
      transaction.status !== "posted" || Boolean(transaction.postedDate),
    {
      message: "Posted transactions require a posted date",
      path: ["postedDate"],
    },
  );

export type FinancialTransactionFormValues = z.infer<
  typeof financialTransactionFormSchema
>;

export const emptyFinancialTransactionForm: FinancialTransactionFormValues = {
  accountId: "",
  purchaseId: "",
  kind: "purchase",
  status: "pending",
  amount: 0,
  transactionDate: "",
  postedDate: "",
  merchant: "",
  rawDescription: "",
  sourceCategory: "",
  sourceRefs: [],
  notes: "",
};

export const normalizeFinancialTransactionForm = (
  values: FinancialTransactionFormValues,
) => ({
  ...values,
  purchaseId: values.purchaseId.trim() || null,
  transactionDate: values.transactionDate || null,
  postedDate: values.postedDate || null,
  merchant: values.merchant.trim() || null,
  rawDescription: values.rawDescription.trim() || null,
  sourceCategory: values.sourceCategory.trim() || null,
  notes: values.notes.trim() || null,
  sourceRefs: values.sourceRefs
    .map((reference) => ({
      source: reference.source.trim(),
      externalId: reference.externalId.trim(),
    }))
    .filter((reference) => reference.source && reference.externalId),
});

const transactionKinds = financialTransactionKind.options;
const transactionStatuses = financialTransactionStatus.options;

export function FinancialTransactionFormFields({
  form,
}: {
  form: UseFormReturn<FinancialTransactionFormValues>;
}) {
  return (
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
        values={transactionKinds}
      />
      <SelectField
        form={form}
        name="status"
        label="Status"
        values={transactionStatuses}
      />
      <TextField form={form} name="amount" label="Amount" type="number" />
      <PlainDateField
        form={form}
        name="transactionDate"
        label="Transaction date"
      />
      <PlainDateField form={form} name="postedDate" label="Posted date" />
      <TextField form={form} name="merchant" label="Merchant" />
      <TextField
        form={form}
        name="rawDescription"
        label="Statement description"
      />
      <TextField form={form} name="sourceCategory" label="Source category" />
      <SourceRefsField form={form} />
      <NullableTextareaField
        form={form}
        name="notes"
        label="Notes"
        placeholder="Optional evidence"
      />
    </>
  );
}
