import type { ReactNode } from "react";
import type { FieldValues, Path, UseFormReturn } from "react-hook-form";
import { cn } from "~/lib/utils";
import {
  NullableNumericField,
  SideBySideFields,
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
  /** Compact mode for dense rows: shorter labels ("Qty"/"Unit") + tighter width. */
  compact?: boolean;
}

export function AmountFieldGroup<
  TFieldValues extends FieldValues = FieldValues,
>({
  form,
  valuePath,
  unitPath,
  step = "1",
  compact = false,
}: AmountFieldGroupProps<TFieldValues>): ReactNode {
  // Function to get unit icon if enabled
  const getIcon = (x: string | null): ReactNode | undefined => {
    if (!x) return undefined;
    return getHoverableMeasureUnitIcon(x);
  };

  return (
    <SideBySideFields
      narrowFirst={compact}
      className={cn(
        compact
          ? "w-full min-w-0 flex-row space-x-2 space-y-0"
          : "min-w-[13rem] space-x-2",
      )}
    >
      <NullableNumericField
        form={form}
        name={valuePath}
        label={compact ? "Qty" : "Amount Value"}
        placeholder={compact ? "1" : "Enter amount"}
        step={step}
        fraction
      />
      <UnifiedTextField
        form={form}
        name={unitPath}
        label={compact ? "Unit" : "Amount Unit"}
        placeholder={compact ? "each" : "Enter unit"}
        nullable={false}
        getIcon={getIcon}
      />
    </SideBySideFields>
  );
}
