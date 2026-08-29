import {
  type MerchantVendorInference,
  financialTransactionKind,
  financialTransactionStatus,
} from "@cubby/schemas/financial-transaction";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { type UseFormReturn, useWatch } from "react-hook-form";
import { z } from "zod";

import {
  NullableTextareaField,
  PlainDateField,
} from "~/app/_components/form-utils";
import { EntityValueField } from "~/app/_components/form-utils/entity-value-field";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { entities, entityDetailParams } from "~/entities/entities";

import { TableLink } from "../_components/table/TableLink";
import { financialTransaction } from "./finance.functions";
import {
  SelectField,
  SourceRefsField,
  TextField,
} from "./financial-form-fields";
import {
  WithFinancialAccountSearch,
  WithPurchaseSearch,
  PurchaseVendorScope,
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
  loadVendorInference,
}: {
  form: UseFormReturn<FinancialTransactionFormValues>;
  loadVendorInference?: (merchant: string) => Promise<MerchantVendorInference>;
}) {
  const merchant = useWatch({ control: form.control, name: "merchant" });
  const [debouncedMerchant] = useDebouncedValue(merchant, { wait: 350 });
  const [allPurchasesVendorId, setAllPurchasesVendorId] = useState<
    string | null
  >(null);
  const inferenceOptions = financialTransaction.vendorInference.queryOptions({
    merchant: debouncedMerchant,
  });
  const inferenceQuery = useQuery({
    ...inferenceOptions,
    queryFn: loadVendorInference
      ? () => loadVendorInference(debouncedMerchant)
      : inferenceOptions.queryFn,
    enabled: debouncedMerchant.trim() !== "",
  });
  const suggested =
    merchant.trim() !== "" && inferenceQuery.data?.status === "suggested"
      ? inferenceQuery.data.candidates[0]
      : null;
  const scopedVendorId =
    suggested && suggested.vendorId !== allPurchasesVendorId
      ? suggested.vendorId
      : null;

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
      <TextField form={form} name="merchant" label="Merchant" />
      <PurchaseVendorScope vendorId={scopedVendorId}>
        <Stack gap="tight">
          {scopedVendorId && suggested ? (
            <Row align="center" justify="between" gap="sm" wrap>
              <span className="text-xs text-muted-foreground">
                Suggested purchases · Showing purchases from{" "}
                <TableLink
                  to={entities.vendor.routes.detail}
                  params={entityDetailParams(scopedVendorId)}
                >
                  {suggested.vendorName}
                </TableLink>
              </span>
              <Button
                type="button"
                variant="link"
                size="sm"
                onClick={() => setAllPurchasesVendorId(scopedVendorId)}
              >
                All purchases
              </Button>
            </Row>
          ) : null}
          <EntityValueField
            form={form}
            name="purchaseId"
            entity="purchase"
            label="Purchase"
            placeholder="Optional linked purchase"
            SearchProvider={WithPurchaseSearch}
            clearable
          />
        </Stack>
      </PurchaseVendorScope>
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
