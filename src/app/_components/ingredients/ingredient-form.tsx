"use client";

import { type FC } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { type IngredientWithRecipesAndProductOut } from "~/schemas/combo";
import {
  ingredientBase,
  type IngredientUpdateInput,
} from "~/schemas/ingredient";
import {
  type CreateModeProps,
  type EditModeProps,
  FormWrapper,
  UnifiedTextField,
  getSubmitButtonText,
  buildUpdateObject,
} from "../form-utils";
import { Input } from "~/components/ui/input";
import { ArrayFieldManager } from "~/components/ui/array-field-manager";

// Form schema for ingredient
const formSchema = z.object({
  name: z.string().min(1, "Name is required"),
  aliases: z.array(z.string()),
});

export type IngredientFormValues = z.infer<typeof formSchema>;

// Props for create mode
interface CreateIngredientFormProps
  extends CreateModeProps<z.infer<typeof ingredientBase>> {
  ingredient?: never;
  initialName?: string;
}

// Props for edit mode
interface EditIngredientFormProps
  extends EditModeProps<
    IngredientUpdateInput,
    IngredientWithRecipesAndProductOut
  > {
  entity: IngredientWithRecipesAndProductOut;
}

// Combined props type
type IngredientFormProps = CreateIngredientFormProps | EditIngredientFormProps;

export const IngredientForm: FC<IngredientFormProps> = (props) => {
  const { mode, isPending, error, onCancel } = props;
  const ingredient = mode === "edit" ? props.entity : undefined;
  const initialName = mode === "create" ? props.initialName : undefined;

  // Initialize form
  const form = useForm<IngredientFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: ingredient ? ingredient.name : (initialName ?? ""),
      aliases: ingredient ? ingredient.aliases : [],
    },
  });

  const handleSubmit = (values: IngredientFormValues) => {
    // Filter out empty alias strings
    const filteredAliases = values.aliases.filter(
      (alias) => alias.trim() !== "",
    );

    if (mode === "create") {
      // For creation, pass all fields
      // Get current date for timestamps (will be replaced by server)
      const createData: z.infer<typeof ingredientBase> = {
        name: values.name,
        aliases: filteredAliases,
      };
      props.onCreate(createData);
    } else if (mode === "edit" && ingredient) {
      // In edit mode, determine which fields have changed
      const updatedValues = {
        ...values,
        aliases: filteredAliases,
      };

      const updates = buildUpdateObject(ingredient, updatedValues, [
        "name",
        "aliases",
      ]);

      // Only update if there are changes
      if (Object.keys(updates).length > 0) {
        const updateData: IngredientUpdateInput = {
          id: ingredient.id,
          data: updates,
        };
        props.onEdit(updateData);
      } else if (onCancel) {
        // If no changes, just run the cancel function
        onCancel();
      }
    }
  };

  const buttonText = getSubmitButtonText(mode, isPending);

  return (
    <FormWrapper
      form={form}
      onSubmit={handleSubmit}
      error={error}
      isPending={isPending}
      onCancel={onCancel}
      submitButtonText={buttonText}
    >
      <UnifiedTextField
        form={form}
        name="name"
        label="Name"
        placeholder="Enter ingredient name"
        nullable={false}
      />

      <ArrayFieldManager<string, IngredientFormValues>
        form={form}
        name="aliases"
        title="Aliases"
        addButtonText="Add Alias"
        emptyValue=""
      >
        {(field, index) => (
          <Input
            {...form.register(`aliases.${index}`)}
            placeholder="Alias name"
            className="flex-1"
          />
        )}
      </ArrayFieldManager>
    </FormWrapper>
  );
};
