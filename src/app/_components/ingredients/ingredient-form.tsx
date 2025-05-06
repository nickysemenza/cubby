"use client";

import { type FC } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { type IngredientWithRecipesAndProductOut } from "~/schemas/combo";
import { ingredientBase } from "~/schemas/ingredient";
import {
  type CreateModeProps,
  type EditModeProps,
  FormWrapper,
  RequiredTextField,
  getSubmitButtonText,
  buildUpdateObject,
} from "../form-utils";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { X } from "lucide-react";

// Form schema for ingredient
const formSchema = z.object({
  name: z.string().min(1, "Name is required"),
  aliases: z.array(z.string()),
});

export type IngredientFormValues = z.infer<typeof formSchema>;

// Create data type
export type CreateIngredientData = z.infer<typeof ingredientBase>;

// Update data type
export type UpdateIngredientData = {
  id: string;
  data: Partial<CreateIngredientData>;
};

// Props for create mode
interface CreateIngredientFormProps
  extends CreateModeProps<CreateIngredientData> {
  ingredient?: never;
  initialName?: string;
}

// Props for edit mode
interface EditIngredientFormProps
  extends EditModeProps<
    UpdateIngredientData,
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

  const { setValue, getValues, watch } = form;
  const aliases = watch("aliases");

  const addAlias = () => {
    const currentAliases = getValues("aliases");
    setValue("aliases", [...currentAliases, ""]);
  };

  const removeAlias = (index: number) => {
    const currentAliases = getValues("aliases");
    setValue(
      "aliases",
      currentAliases.filter((_, i) => i !== index),
    );
  };

  const updateAlias = (index: number, value: string) => {
    const currentAliases = [...getValues("aliases")];
    currentAliases[index] = value;
    setValue("aliases", currentAliases);
  };

  const handleSubmit = (values: IngredientFormValues) => {
    // Filter out empty alias strings
    const filteredAliases = values.aliases.filter(
      (alias) => alias.trim() !== "",
    );

    if (mode === "create") {
      // For creation, pass all fields
      // Get current date for timestamps (will be replaced by server)
      const createData: CreateIngredientData = {
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
        const updateData: UpdateIngredientData = {
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
      <RequiredTextField
        form={form}
        name="name"
        label="Name"
        placeholder="Enter ingredient name"
      />

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium">Aliases</label>
          <Button type="button" variant="outline" size="sm" onClick={addAlias}>
            Add Alias
          </Button>
        </div>

        {aliases.length === 0 ? (
          <div className="text-muted-foreground text-sm">No aliases added</div>
        ) : (
          <div className="space-y-2">
            {aliases.map((alias, index) => (
              <div key={index} className="flex items-center space-x-2">
                <Input
                  value={alias}
                  onChange={(e) => updateAlias(index, e.target.value)}
                  placeholder="Alias name"
                  className="flex-1"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => removeAlias(index)}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </FormWrapper>
  );
};
