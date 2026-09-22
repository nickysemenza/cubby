/**
 * DiscardLineFields — the trade/date/reason trio shared by `ProductDiscardDialog`
 * and `BulkDiscardInventoryDialog`.
 *
 * Both dialogs write a $0 expense line, and `expense.trade` is Jev-enabled in
 * the manifest — but neither ever mounted a `FieldSuggestionProvider`, so
 * nothing ever asked. Owning the provider here (rather than in each dialog)
 * is what makes that gap impossible to reintroduce: `FieldSuggestionProvider`
 * calls `useFormContext()`, so it needs a `FormProvider` around it, and this
 * component supplies both in one place instead of trusting every future
 * discard-line caller to remember.
 */
import type { ProductShortcode } from "@cubby/schemas/identifiers";
import type { Trade } from "@cubby/schemas/task-fields";
import {
  FormProvider,
  type FieldPathByValue,
  type FieldValues,
  type Path,
  type UseFormReturn,
} from "react-hook-form";

import { FieldSuggestionProvider } from "~/app/_components/ai/field-suggestion-provider";
import { tradeOptions } from "~/app/projects/trade-options";

import { PlainDateField, SelectField, UnifiedTextField } from "../form-utils";

export interface DiscardLineFieldValues extends FieldValues {
  trade: Trade | null;
  date: string | null;
  reason: string;
}

export function DiscardLineFields<TFieldValues extends DiscardLineFieldValues>({
  form,
  productId,
  productName,
}: {
  form: UseFormReturn<TFieldValues>;
  /** Basis for the trade suggestion. `undefined` when the discard spans more
   * than one product (bulk discard) — the suggestion is ambiguous without a
   * single product to reason about, same gate as bulk-edit's single-item
   * basis rule, so the provider fields no targets rather than guess. */
  productId?: ProductShortcode;
  productName?: string;
}) {
  // SAFETY: `TFieldValues extends DiscardLineFieldValues` guarantees `date`
  // is a `string | null` path; the generic form helpers can't see that from
  // a type parameter, only from a concrete one.
  const dateName = "date" as FieldPathByValue<
    TFieldValues,
    string | null | undefined
  >;
  // SAFETY: same relationship as `dateName` above — `trade` is declared on
  // `DiscardLineFieldValues`.
  const tradeName = "trade" as Path<TFieldValues>;
  // SAFETY: same relationship as `dateName` above — `reason` is a `string`
  // path on `DiscardLineFieldValues`.
  const reasonName = "reason" as FieldPathByValue<
    TFieldValues,
    string | null | undefined
  >;
  return (
    <FormProvider {...form}>
      <FieldSuggestionProvider
        entity="expense"
        mode="create"
        staticBasis={
          productId ? { productId, name: productName ?? null } : undefined
        }
        paths={{ notes: "reason" }}
        fieldKeys={["trade"]}
        disabled={!productId}
      >
        <PlainDateField
          form={form}
          name={dateName}
          label="Date"
          clearLabel="Date unknown"
        />
        <SelectField
          form={form}
          name={tradeName}
          label="Trade"
          options={tradeOptions}
          placeholder="Choose a trade…"
          suggestField="trade"
        />
        <UnifiedTextField
          form={form}
          name={reasonName}
          label="Reason"
          placeholder="Broke, worn out, given away…"
        />
      </FieldSuggestionProvider>
    </FormProvider>
  );
}
