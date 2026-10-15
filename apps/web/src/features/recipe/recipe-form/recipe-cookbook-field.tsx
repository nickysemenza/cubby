import type { UseFormReturn } from "react-hook-form";

import { PickerField } from "~/entity/forms/picker-field";
import { referenceEntitySearch } from "~/entity/picker/reference-entity-search";

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
