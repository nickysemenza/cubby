import { type Control, Controller } from "react-hook-form";

import { Picker } from "~/ui/combobox/picker";

import { FormFieldGroup } from "../../../ui/forms/form-field-group";
import { useCookbookOptions } from "../cookbook-select";
import type { RecipeFormValues } from "./types";

/**
 * Re-points a recipe at another cookbook, or none. The edit surface for a
 * recipe whose book was attached wrong; import is what normally sets it.
 */
export function RecipeCookbookField({
  control,
}: {
  control: Control<RecipeFormValues>;
}) {
  const options = useCookbookOptions("No cookbook");
  return (
    <Controller
      control={control}
      name="cookbookId"
      render={({ field }) => (
        <FormFieldGroup htmlFor="recipe-cookbook" label="Cookbook (Optional)">
          <Picker
            inputId="recipe-cookbook"
            inputRef={field.ref}
            label="Cookbook (Optional)"
            className="w-full"
            options={options}
            value={field.value ?? ""}
            onValueChange={(next) => field.onChange(next || null)}
          />
        </FormFieldGroup>
      )}
    />
  );
}
