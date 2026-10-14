import type { UseFormReturn } from "react-hook-form";

import { referenceEntitySearch } from "~/ui/combobox/reference-entity-search";
import { PickerField } from "~/ui/form-utils/picker-field";

import type { RecipeFormValues } from "./types";

const CookbookSearch = referenceEntitySearch("cookbook");

/**
 * Re-points a recipe at another cookbook, or none. The edit surface for a
 * recipe whose book was attached wrong; import is what normally sets it.
 * Clearing writes `""`, which the update adapter sends as `null`.
 */
export function RecipeCookbookField({
  form,
}: {
  form: UseFormReturn<RecipeFormValues>;
}) {
  return (
    <PickerField
      store="id"
      form={form}
      name="cookbookId"
      label="Cookbook (Optional)"
      placeholder="No cookbook"
      entity="cookbook"
      SearchProvider={CookbookSearch}
      clearable
    />
  );
}
