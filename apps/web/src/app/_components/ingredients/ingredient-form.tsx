import type {
  IngredientUpdateInput,
  IngredientWithRecipesAndProductOut,
  ingredientBase,
} from "@cubby/schemas/ingredient";
import { zodResolver } from "@hookform/resolvers/zod";
import type { FC } from "react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";
import { ArrayFieldManager } from "~/components/forms/array-field-manager";
import { Card, CardContent } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import {
  buildUpdateObject,
  type CreateModeProps,
  type EditModeProps,
  FormWrapper,
  getSubmitButtonText,
  submitOrCancel,
  UnifiedTextField,
} from "../form-utils";

// Form schema for ingredient
const formSchema = z.object({
  name: z.string().min(1, "Name is required"),
  aliases: z.array(z.string()),
});

type IngredientFormValues = z.infer<typeof formSchema>;

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

      submitOrCancel(
        updates,
        () => ({ id: ingredient.id, data: updates }),
        props.onEdit,
        onCancel,
      );
    }
  };

  const buttonText = getSubmitButtonText(mode);

  return (
    <FormWrapper
      form={form}
      onSubmit={handleSubmit}
      error={error}
      isPending={isPending}
      onCancel={onCancel}
      submitButtonText={buttonText}
    >
      <Card>
        <CardContent className="px-4 py-1">
          <UnifiedTextField
            form={form}
            name="name"
            label="Name"
            placeholder="Enter ingredient name"
            nullable={false}
          />
        </CardContent>
      </Card>

      <ArrayFieldManager<string, IngredientFormValues>
        form={form}
        name="aliases"
        title="Aliases"
        addButtonText="Add Alias"
        emptyValue=""
      >
        {(_field, index) => (
          <Controller
            control={form.control}
            name={`aliases.${index}`}
            render={({ field: controllerField }) => (
              <Input
                {...controllerField}
                placeholder="Alias name"
                className="flex-1"
              />
            )}
          />
        )}
      </ArrayFieldManager>
    </FormWrapper>
  );
};
