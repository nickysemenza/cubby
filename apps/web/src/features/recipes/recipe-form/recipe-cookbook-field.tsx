import type { UseFormReturn } from "react-hook-form";

import { PickerField } from "~/ui/form-utils/picker-field";

import { useCookbookOptions } from "../cookbook-select";
import type { RecipeFormValues } from "./types";

/**
 * Re-points a recipe at another cookbook, or none. The edit surface for a
 * recipe whose book was attached wrong; import is what normally sets it.
 */
export function RecipeCookbookField({
  form,
}: {
  form: UseFormReturn<RecipeFormValues>;
}) {
  return (
    <PickerField
      store="option"
      form={form}
      name="cookbookId"
      label="Cookbook (Optional)"
      options={useCookbookOptions()}
      nullable
      noneLabel="No cookbook"
    />
  );
}
