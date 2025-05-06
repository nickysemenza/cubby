"use client";

import { type FC } from "react";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  type ProductInputPayload,
  type ProductTopLevelOut,
} from "~/schemas/product";
import { upc, ndb } from "~/schemas/util";
import { NullableComboboxItem } from "../combobox";
import {
  type CreateModeProps,
  type EditModeProps,
  FormWrapper,
  RequiredTextField,
  NullableTextField,
  NullableNumberField,
  getSubmitButtonText,
  buildUpdateObject,
  SideBySideFields,
  ComboboxField,
  detectComboboxIdChange,
} from "../form-utils";
import { Button } from "~/components/ui/button";
import { Plus, X } from "lucide-react";
import { unitMappingInput, type UnitMappingInput } from "~/schemas/unitmapping";
import { WithIngredientSearch } from "../combobox/with-search-hook";

// Form schema for product form
const formSchema = z
  .object({
    name: z.string().min(1, "Name is required"),
    manufacturer: z.string().min(1, "Manufacturer is required"),
    model: z.string().nullable(),
    upc: upc.nullable(), // Allow empty string and transform to null
    ndb_number: ndb.nullable(), // Allow empty string and transform to null
    ingredient: NullableComboboxItem, // Ingredient association
    unitMappings: z.array(unitMappingInput),
  })
  .transform((data) => ({
    ...data,
    upc: data.upc === "" ? null : data.upc,
    ndb_number: data.ndb_number === 0 ? null : data.ndb_number,
  }));

export type ProductFormValues = z.infer<typeof formSchema>;

// Use the backend type for creation data
export type CreateProductData = ProductInputPayload & {
  unitMappings: UnitMappingInput[];
};

// Define the props passed by parent for update operation
export type UpdateProductData = {
  id: string;
  data: Partial<CreateProductData>;
};

// Props for create mode
interface CreateProductFormProps extends CreateModeProps<CreateProductData> {
  product?: never;
}

// Define a custom type for product with ingredient and unit mappings
interface ProductWithIngredient extends ProductTopLevelOut {
  ingredient?: {
    id: string;
    name: string;
  } | null;
  unitMappings: UnitMappingInput[];
}

// Props for edit mode
interface EditProductFormProps
  extends EditModeProps<UpdateProductData, ProductWithIngredient> {
  entity: ProductWithIngredient;
}

// Combined props type using discriminated union
type ProductFormProps = CreateProductFormProps | EditProductFormProps;

export const ProductForm: FC<ProductFormProps> = (props) => {
  const { mode, isPending, error, onCancel } = props;

  // Get the product entity in edit mode
  const product = mode === "edit" ? props.entity : undefined;

  // Initialize form with default values or existing product data
  const form = useForm<ProductFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: product ? product.name : "",
      manufacturer: product ? product.manufacturer : "",
      model: product ? product.model : null,
      upc: product ? product.upc : null,
      ndb_number: product ? product.ndb_number : null,
      ingredient: product?.ingredient,
      unitMappings: product?.unitMappings ?? [],
    },
  });

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "unitMappings",
  });

  const handleSubmit = (values: ProductFormValues) => {
    if (mode === "create") {
      // For creation, pass all fields
      const createData: CreateProductData = {
        name: values.name,
        manufacturer: values.manufacturer,
        model: values.model,
        upc: values.upc,
        ndb_number: values.ndb_number,
        ingredientId: values.ingredient?.id || null,
        unitMappings: values.unitMappings,
      };
      props.onCreate(createData);
    } else if (mode === "edit" && product) {
      // In edit mode, determine which fields have changed
      const updates: Partial<CreateProductData> = buildUpdateObject(
        {
          ...product,
        },
        values,
        ["name", "manufacturer", "model", "upc", "ndb_number"],
      );

      // Check for ingredient changes
      const ingredientId = detectComboboxIdChange(
        product.ingredient ? product.ingredient.id : null,
        values.ingredient,
      );

      if (ingredientId !== undefined) {
        updates.ingredientId = ingredientId;
      }

      // Check for unit mapping changes
      if (
        JSON.stringify(product.unitMappings) !==
        JSON.stringify(values.unitMappings)
      ) {
        updates.unitMappings = values.unitMappings;
      }

      // Only update if there are changes
      if (Object.keys(updates).length > 0) {
        const updateData: UpdateProductData = {
          id: product.id,
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
        placeholder="Enter product name"
      />

      <RequiredTextField
        form={form}
        name="manufacturer"
        label="Manufacturer"
        placeholder="Enter manufacturer"
      />

      <NullableTextField
        form={form}
        name="model"
        label="Model (Optional)"
        placeholder="Enter model"
      />

      <SideBySideFields>
        <NullableTextField
          form={form}
          name="upc"
          label="UPC (Optional)"
          placeholder="12-digit UPC code"
        />

        <NullableNumberField
          form={form}
          name="ndb_number"
          label="NDB Number (Optional)"
          placeholder="NDB number (1000-99999)"
        />
      </SideBySideFields>
      <WithIngredientSearch>
        {({ findItems }) => (
          <ComboboxField
            form={form}
            name="ingredient"
            label="Ingredient"
            findItems={findItems}
          />
        )}
      </WithIngredientSearch>

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-medium">Unit Mappings</h3>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              append({
                a: { value: 1, unit: "" },
                b: { value: 1, unit: "" },
                source: null,
              })
            }
          >
            <Plus className="mr-2 h-4 w-4" />
            Add Mapping
          </Button>
        </div>

        {fields.map((field, index) => (
          <div key={field.id} className="space-y-4 rounded-lg border p-4">
            <div className="flex justify-between">
              <h4 className="font-medium">Mapping {index + 1}</h4>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => remove(index)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <h5 className="text-sm font-medium">From</h5>
                <SideBySideFields>
                  <NullableNumberField
                    form={form}
                    name={`unitMappings.${index}.a.value`}
                    label="Value"
                    placeholder="Enter value"
                  />
                  <RequiredTextField
                    form={form}
                    name={`unitMappings.${index}.a.unit`}
                    label="Unit"
                    placeholder="Enter unit"
                  />
                </SideBySideFields>
              </div>

              <div className="space-y-2">
                <h5 className="text-sm font-medium">To</h5>
                <SideBySideFields>
                  <NullableNumberField
                    form={form}
                    name={`unitMappings.${index}.b.value`}
                    label="Value"
                    placeholder="Enter value"
                  />
                  <RequiredTextField
                    form={form}
                    name={`unitMappings.${index}.b.unit`}
                    label="Unit"
                    placeholder="Enter unit"
                  />
                </SideBySideFields>
              </div>
            </div>

            <NullableTextField
              form={form}
              name={`unitMappings.${index}.source`}
              label="Source (Optional)"
              placeholder="Enter source"
            />
          </div>
        ))}
      </div>
    </FormWrapper>
  );
};
