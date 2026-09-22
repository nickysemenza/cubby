import {
  type MerchantVendorInference,
  financialTransactionKind,
  financialTransactionStatus,
} from "@cubby/schemas/financial-transaction";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { FormProvider, type UseFormReturn, useWatch } from "react-hook-form";
import { z } from "zod";

import { EntityValueField } from "~/app/_components/form-utils/entity-value-field";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import type { EditMode } from "~/entities/editing/entity-field-presentation";
import {
  EntityPrimitiveFields,
  renderIntentField,
  requiredFieldModel,
} from "~/entities/editing/entity-primitive-fields";
import { entities, entityDetailParams } from "~/entities/entities";

import { TableLink } from "../_components/table/TableLink";
import { financialTransaction } from "./finance.functions";
import {
  WithFinancialAccountSearch,
  WithPurchaseSearch,
  PurchaseVendorScope,
} from "./financial-selectors";

const financialTransactionSourceRefsField = requiredFieldModel(
  "financialTransaction",
  "sourceRefs",
);

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
    merchant: z.string().nullable(),
    rawDescription: z.string().nullable(),
    sourceCategory: z.string().nullable(),
    sourceRefs: z.array(
      z.object({ source: z.string(), externalId: z.string() }),
    ),
    notes: z.string().nullable(),
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
  merchant: values.merchant?.trim() || null,
  rawDescription: values.rawDescription?.trim() || null,
  sourceCategory: values.sourceCategory?.trim() || null,
  notes: values.notes?.trim() || null,
  sourceRefs: values.sourceRefs
    .map((reference) => ({
      source: reference.source.trim(),
      externalId: reference.externalId.trim(),
    }))
    .filter((reference) => reference.source && reference.externalId),
});

export function FinancialTransactionFormFields({
  form,
  loadVendorInference,
  mode = "create",
}: {
  form: UseFormReturn<FinancialTransactionFormValues>;
  mode?: EditMode;
  loadVendorInference?: (merchant: string) => Promise<MerchantVendorInference>;
}) {
  const idPrefix = useId();
  const merchant = useWatch({ control: form.control, name: "merchant" }) ?? "";
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
    <FormProvider {...form}>
      <EntityValueField
        form={form}
        name="accountId"
        entity="financialAccount"
        label="Account"
        placeholder="Select account"
        SearchProvider={WithFinancialAccountSearch}
      />
      <EntityPrimitiveFields
        entity="financialTransaction"
        mode={mode}
        section="identity"
      />
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
      <EntityPrimitiveFields
        entity="financialTransaction"
        mode={mode}
        section="main"
        options={{ amount: { step: "0.01" } }}
      />
      <EntityPrimitiveFields
        entity="financialTransaction"
        mode={mode}
        section="schedule"
      />
      <EntityPrimitiveFields
        entity="financialTransaction"
        mode={mode}
        section="details"
      />
      {renderIntentField({
        entity: "financialTransaction",
        field: financialTransactionSourceRefsField,
        // SAFETY: `renderIntentField` is shared across every entity's form
        // and so takes the broad `UseFormReturn<FieldValues>` RHF uses
        // internally; this form's own values (`FinancialTransactionFormValues`)
        // are a `FieldValues`-compatible shape, just not the literal generic
        // parameter RHF's invariant-ish method signatures expect here — the
        // same single-assertion escape `financial-form-fields.tsx`'s own
        // `TextField`/`SelectField` use for a caller-owned dynamic path.
        form: form as never,
        idPrefix,
        mode,
        scopedValueRecord: {},
      })}
      <EntityPrimitiveFields
        entity="financialTransaction"
        mode={mode}
        section="notes"
        options={{ notes: { placeholder: "Optional evidence" } }}
      />
    </FormProvider>
  );
}
