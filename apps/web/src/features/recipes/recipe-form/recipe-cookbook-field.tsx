import { useQuery } from "@tanstack/react-query";
import { type Control, Controller } from "react-hook-form";

import { cookbook } from "~/integrations/tanstack-query/generated/cookbook.gen";
import { NativeSelect } from "~/ui/primitives/native-select";

import { FormFieldGroup } from "../../../ui/forms/form-field-group";
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
  const { data: cookbooks } = useQuery(cookbook.list.queryOptions(null));
  return (
    <Controller
      control={control}
      name="cookbookId"
      render={({ field }) => (
        <FormFieldGroup htmlFor="recipe-cookbook" label="Cookbook (Optional)">
          <NativeSelect
            id="recipe-cookbook"
            className="w-full"
            value={field.value ?? ""}
            onChange={(event) => field.onChange(event.target.value || null)}
          >
            <option value="">No cookbook</option>
            {cookbooks?.map((book) => (
              <option key={book.id} value={book.id}>
                {book.name}
              </option>
            ))}
          </NativeSelect>
        </FormFieldGroup>
      )}
    />
  );
}
