"use client";

import type { UseFormReturn, FieldValues, Path } from "react-hook-form";
import type { ReactNode } from "react";
import {
  SideBySideFields,
  NullableNumericField,
  UnifiedTextField,
} from "../form-utils";
import { getHoverableMeasureUnitIcon } from "./format-amount";

interface AmountFieldGroupProps<
  TFieldValues extends FieldValues = FieldValues,
> {
  form: UseFormReturn<TFieldValues>;
  valuePath: Path<TFieldValues>;
  unitPath: Path<TFieldValues>;
  step?: string;
}

export function AmountFieldGroup<
  TFieldValues extends FieldValues = FieldValues,
>({
  form,
  valuePath,
  unitPath,
  step = "1",
}: AmountFieldGroupProps<TFieldValues>): ReactNode {
  // Function to get unit icon if enabled
  const getIcon = (x: string | null): ReactNode | undefined => {
    if (!x) return undefined;
    return getHoverableMeasureUnitIcon(x);
  };

  return (
    <SideBySideFields className="min-w-[13rem] space-x-3">
      <NullableNumericField
        form={form}
        name={valuePath}
        label="Amount Value"
        placeholder="Enter amount"
        step={step}
      />
      <UnifiedTextField
        form={form}
        name={unitPath}
        label="Amount Unit"
        placeholder="Enter unit"
        nullable={false}
        getIcon={getIcon}
      />
    </SideBySideFields>
  );
}
