import type { CategorySuggestion } from "@cubby/schemas/ai";
import type { FieldValues, Path, UseFormReturn } from "react-hook-form";
import { ai } from "~/lib/ai.functions";
import { FieldWithAISuggest } from "../ai/ai-suggest";
import { SelectField } from "../form-utils";
import { productCategoryOptionsWithTheme } from "./product-category-icons";

interface CategoryFieldWithAIProps<
  TFieldValues extends FieldValues = FieldValues,
> {
  form: UseFormReturn<TFieldValues>;
  name: Path<TFieldValues>;
  productName: string;
  manufacturer: string;
  disabled?: boolean;
  description?: string;
}

export function CategoryFieldWithAI<
  TFieldValues extends FieldValues = FieldValues,
>({
  form,
  name,
  productName,
  manufacturer,
  disabled = false,
  description,
}: CategoryFieldWithAIProps<TFieldValues>) {
  const enabled = !!(productName.trim() && manufacturer.trim());

  return (
    <FieldWithAISuggest<CategorySuggestion>
      field={
        <SelectField
          form={form}
          name={name}
          label="Category"
          options={productCategoryOptionsWithTheme}
          placeholder="Select category"
          nullable={true}
          disabled={disabled}
          description={description}
        />
      }
      enabled={enabled}
      disabledReason={
        !productName.trim()
          ? "Enter product name first"
          : "Enter manufacturer first"
      }
      suggestLabel="Use AI to suggest category"
      basisKey={`${productName}\u0000${manufacturer}`}
      currentValue={form.watch(name)}
      fieldDirty={form.getFieldState(name).isDirty}
      runSuggest={() => ai.suggestCategory.call({ productName, manufacturer })}
      onAccept={(r) =>
        form.setValue(name, r.category as TFieldValues[typeof name])
      }
    />
  );
}
