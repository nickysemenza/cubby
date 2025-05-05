"use client";

import { type FC } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { productBase, type ProductTopLevelOut } from "~/schemas/product";
import { upc, ndb } from "~/schemas/util";
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
} from "../form-utils";

// Form schema for product form
const formSchema = z
  .object({
    name: z.string().min(1, "Name is required"),
    manufacturer: z.string().min(1, "Manufacturer is required"),
    model: z.string().nullable(),
    upc: upc.nullable(), // Allow empty string and transform to null
    ndb_number: ndb.nullable(), // Allow empty string and transform to null
  })
  .transform((data) => ({
    ...data,
    upc: data.upc === "" ? null : data.upc,
    ndb_number: data.ndb_number === 0 ? null : data.ndb_number,
  }));

export type ProductFormValues = z.infer<typeof formSchema>;

// Use the backend type for creation data
export type CreateProductData = z.infer<typeof productBase>;

// Define the props passed by parent for update operation
export type UpdateProductData = {
  id: string;
  data: Partial<CreateProductData>;
};

// Props for create mode
interface CreateProductFormProps extends CreateModeProps<CreateProductData> {
  product?: never;
}

// Props for edit mode
interface EditProductFormProps
  extends EditModeProps<UpdateProductData, ProductTopLevelOut> {
  entity: ProductTopLevelOut;
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
    },
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
      };
      props.onCreate(createData);
    } else if (mode === "edit" && product) {
      // In edit mode, determine which fields have changed
      const updates = buildUpdateObject(product, values, [
        "name",
        "manufacturer",
        "model",
        "upc",
        "ndb_number",
      ]);

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
    </FormWrapper>
  );
};
