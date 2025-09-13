"use client";

import { type FC } from "react";
import { useForm } from "react-hook-form";
import { useImageState } from "~/hooks/useImageState";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  type ProductInputPayload,
  type ProductTopLevelOut,
} from "~/schemas/product";
import { upc } from "@recipehub/usda-schemas";

import { ndb } from "@recipehub/usda-schemas";
import { ComboboxItem } from "../combobox/combobox-types";
import {
  type CreateModeProps,
  type EditModeProps,
  FormWrapper,
  UnifiedTextField,
  getSubmitButtonText,
  buildUpdateObject,
  SideBySideFields,
  ComboboxField,
  detectComboboxIdChange,
  NullableNumericField,
} from "../form-utils";
import { AmountFieldGroup } from "../inventory/amount-field-group";
import { unitMappingInput, type UnitMappingInput } from "~/schemas/unitmapping";
import { ArrayFieldManager } from "~/components/ui/array-field-manager";
import { WithIngredientSearch } from "../combobox/with-search-hook";
import { PendingImageUpload, type PendingImage } from "../PendingImageUpload";
import { type ImageOut } from "~/schemas/image";

// Form schema for product form
const formSchema = z
  .object({
    name: z.string().min(1, "Name is required"),
    manufacturer: z.string().min(1, "Manufacturer is required"),
    model: z.string().nullable(),
    upc: upc.nullable(), // Allow empty string and transform to null
    ndb_number: ndb.nullable(), // Allow empty string and transform to null
    ingredient: ComboboxItem.nullable(), // Ingredient association
    unitMappings: z.array(unitMappingInput),
  })
  .transform((data) => ({
    ...data,
    upc: data.upc === "" ? null : data.upc,
    ndb_number: data.ndb_number === 0 ? null : data.ndb_number,
  }));

type ProductFormValues = z.infer<typeof formSchema>;

// Props for create mode
interface CreateProductFormProps extends CreateModeProps<ProductInputPayload> {
  product?: never;
  initialName?: string;
}

// Define a custom type for product with ingredient and unit mappings
interface ProductWithIngredient extends Omit<ProductTopLevelOut, "images"> {
  ingredient?: {
    id: string;
    name: string;
  } | null;
  unitMappings: UnitMappingInput[];
  images?: PendingImage[] | ImageOut[];
}

// Props for edit mode
interface EditProductFormProps
  extends EditModeProps<
    {
      id: string;
      data: Partial<ProductInputPayload>;
    },
    ProductWithIngredient
  > {
  entity: ProductWithIngredient;
}

// Combined props type using discriminated union
type ProductFormProps = CreateProductFormProps | EditProductFormProps;

export const ProductForm: FC<ProductFormProps> = (props) => {
  const { mode, isPending, error, onCancel } = props;
  const {
    handlePendingImagesChange,
    handleRemovedImagesChange,
    getImageData,
    hasImageChanges,
  } = useImageState();

  // Get the product entity in edit mode
  const product = mode === "edit" ? props.entity : undefined;
  const initialName = mode === "create" ? props.initialName : undefined;

  // Initialize form with default values or existing product data
  const form = useForm<ProductFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: product ? product.name : (initialName ?? ""),
      manufacturer: product ? product.manufacturer : "",
      model: product ? product.model : null,
      upc: product ? product.upc : null,
      ndb_number: product ? product.ndb_number : null,
      ingredient: product?.ingredient || null,
      unitMappings: product?.unitMappings ?? [],
    },
  });

  const handleSubmit = (values: ProductFormValues) => {
    if (mode === "create") {
      // For creation, pass all fields
      const createData: ProductInputPayload = {
        name: values.name,
        manufacturer: values.manufacturer,
        model: values.model,
        upc: values.upc,
        ndb_number: values.ndb_number,
        ingredientId: values.ingredient?.id || null,
        unitMappings: values.unitMappings,
        ...getImageData(true), // Apply pending images for creation
      };

      props.onCreate(createData);
    } else if (mode === "edit" && product) {
      // In edit mode, determine which fields have changed
      const updates: Partial<ProductInputPayload> = buildUpdateObject(
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

      // Check if we have any changes (field changes or image changes)
      const imageChanges = hasImageChanges();
      const hasFieldChanges = Object.keys(updates).length > 0;

      // Only update if there are changes
      if (hasFieldChanges || imageChanges) {
        const updateData = {
          id: product.id,
          data: {
            ...updates,
            ...getImageData(), // Apply image updates
          },
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
        placeholder="Enter product name"
        nullable={false}
      />

      <UnifiedTextField
        form={form}
        name="manufacturer"
        label="Manufacturer"
        placeholder="Enter manufacturer"
        nullable={false}
      />

      <UnifiedTextField
        form={form}
        name="model"
        label="Model (Optional)"
        placeholder="Enter model"
        nullable={true}
      />

      <SideBySideFields>
        <UnifiedTextField
          form={form}
          name="upc"
          label="UPC (Optional)"
          placeholder="12-digit UPC code"
          nullable={true}
        />

        <NullableNumericField
          form={form}
          step="1"
          name="ndb_number"
          label="NDB Number (Optional)"
          placeholder="NDB number (1000-99999)"
        />
      </SideBySideFields>
      <WithIngredientSearch>
        {({ findItems, onCreateNew }) => (
          <ComboboxField
            form={form}
            name="ingredient"
            label="Ingredient"
            findItems={findItems}
            onCreateNew={onCreateNew}
            insideDialog={mode === "create"}
          />
        )}
      </WithIngredientSearch>

      {/* Show image upload in both create and edit modes */}
      <PendingImageUpload
        entityType="PRODUCT"
        onImagesChange={handlePendingImagesChange}
        existingImages={
          mode === "edit" && product?.images ? product.images : []
        }
        onExistingImagesRemove={handleRemovedImagesChange}
        className="mt-4"
      />

      <ArrayFieldManager<UnitMappingInput, ProductFormValues>
        form={form}
        name="unitMappings"
        title="Unit Mappings"
        addButtonText="Add Mapping"
        emptyValue={{
          a: { value: 1, unit: "" },
          b: { value: 1, unit: "" },
          source: null,
        }}
      >
        {(_, index) => (
          <>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <h5 className="text-sm font-medium">From</h5>
                <AmountFieldGroup
                  form={form}
                  valuePath={`unitMappings.${index}.a.value`}
                  unitPath={`unitMappings.${index}.a.unit`}
                />
              </div>

              <div className="space-y-2">
                <h5 className="text-sm font-medium">To</h5>
                <AmountFieldGroup
                  form={form}
                  valuePath={`unitMappings.${index}.b.value`}
                  unitPath={`unitMappings.${index}.b.unit`}
                />
              </div>
            </div>

            <UnifiedTextField
              form={form}
              name={`unitMappings.${index}.source`}
              label="Source (Optional)"
              placeholder="Enter source"
              nullable={true}
            />
          </>
        )}
      </ArrayFieldManager>
    </FormWrapper>
  );
};
