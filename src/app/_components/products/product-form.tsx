"use client";

import { type FC } from "react";
import { Input } from "~/components/ui/input";
import { Button } from "~/components/ui/button";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "~/components/ui/form";
import { productBase, type ProductTopLevelOut } from "~/schemas/product";
import { upc, ndb } from "~/schemas/util";

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

// Base props shared by both modes
interface BaseProductFormProps {
  isPending: boolean;
  error?: string;
  onCancel?: () => void;
}

// Props for create mode
interface CreateProductFormProps extends BaseProductFormProps {
  mode: "create";
  onCreate: (data: CreateProductData) => void;
  onEdit?: never;
  product?: never;
}

// Props for edit mode
interface EditProductFormProps extends BaseProductFormProps {
  mode: "edit";
  onEdit: (data: UpdateProductData) => void;
  onCreate?: never;
  product: ProductTopLevelOut;
}

// Combined props type using discriminated union
type ProductFormProps = CreateProductFormProps | EditProductFormProps;

export const ProductForm: FC<ProductFormProps> = (props) => {
  const { mode, isPending, error, onCancel } = props;

  // Initialize form with default values or existing product data
  const form = useForm<ProductFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: props.mode === "edit" && props.product ? props.product.name : "",
      manufacturer:
        props.mode === "edit" && props.product
          ? props.product.manufacturer
          : "",
      model:
        props.mode === "edit" && props.product ? props.product.model : null,
      upc: props.mode === "edit" && props.product ? props.product.upc : null,
      ndb_number:
        props.mode === "edit" && props.product
          ? props.product.ndb_number
          : null,
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
    } else if (mode === "edit") {
      const product = props.product;
      // In edit mode, determine which fields have changed
      const updates: Partial<CreateProductData> = {};

      if (values.name !== product.name) {
        updates.name = values.name;
      }

      if (values.manufacturer !== product.manufacturer) {
        updates.manufacturer = values.manufacturer;
      }

      if (values.model !== product.model) {
        updates.model = values.model;
      }

      if (values.upc !== product.upc) {
        updates.upc = values.upc;
      }

      if (values.ndb_number !== product.ndb_number) {
        updates.ndb_number = values.ndb_number;
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

  const buttonText =
    mode === "create"
      ? isPending
        ? "Creating..."
        : "Create"
      : isPending
        ? "Saving..."
        : "Save";

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-6">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Name</FormLabel>
              <FormControl>
                <Input placeholder="Enter product name" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="manufacturer"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Manufacturer</FormLabel>
              <FormControl>
                <Input placeholder="Enter manufacturer" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="model"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Model (Optional)</FormLabel>
              <FormControl>
                <Input
                  placeholder="Enter model"
                  {...field}
                  value={field.value || ""}
                  onChange={(e) => {
                    const value = e.target.value;
                    field.onChange(value === "" ? null : value);
                  }}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="flex space-x-4">
          <FormField
            control={form.control}
            name="upc"
            render={({ field }) => (
              <FormItem className="flex-1">
                <FormLabel>UPC (Optional)</FormLabel>
                <FormControl>
                  <Input
                    placeholder="12-digit UPC code"
                    {...field}
                    value={field.value || ""}
                    onChange={(e) => {
                      const value = e.target.value;
                      field.onChange(value === "" ? null : value);
                    }}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="ndb_number"
            render={({ field }) => (
              <FormItem className="flex-1">
                <FormLabel>NDB Number (Optional)</FormLabel>
                <FormControl>
                  <Input
                    placeholder="NDB number (1000-99999)"
                    {...field}
                    value={field.value !== null ? field.value.toString() : ""}
                    onChange={(e) => {
                      const value = e.target.value;
                      const numberValue = value ? parseInt(value, 10) : null;
                      field.onChange(numberValue);
                    }}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {error && <div className="text-sm text-red-500">{error}</div>}

        <div className="flex space-x-2">
          <Button type="submit" disabled={isPending}>
            {buttonText}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={isPending}
          >
            Cancel
          </Button>
        </div>
      </form>
    </Form>
  );
};
