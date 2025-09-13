"use client";

import { UseFormReturn, FieldValues, Path } from "react-hook-form";
import { ReactNode } from "react";
import {
  SideBySideFields,
  NullableNumericField,
  UnifiedTextField,
} from "../form-utils";
import { useWasm } from "~/hooks/useWasm";
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
  const w = useWasm();

  // Function to get unit icon if enabled
  const getIcon = (x: string | null): ReactNode | undefined => {
    if (!x) return undefined;
    return getHoverableMeasureUnitIcon(w, x);
  };

  return (
    <SideBySideFields>
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
