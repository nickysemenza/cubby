"use client";

import { useWasm } from "~/wasmContext";
import { type FC } from "react";
import { Input } from "~/components/ui/input";
import { Button } from "~/components/ui/button";
import { Amount } from "~/codec/codec";
import { api } from "~/trpc/react";
import {
  clientSideFilter,
  Combobox,
  ComboboxItem,
} from "~/app/_components/combobox";
import {
  buildProductComboboxItem,
  buildLocationComboboxItem,
} from "~/app/_components/combobox/utils";
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
import { type inventoryWithLocationAndProductOut } from "~/schemas/combo";
import {
  inventoryCreatePayloadData,
  inventoryUpdatePayloadData,
} from "~/schemas/inventory";

// Form schema for inventory form
const formSchema = z.object({
  product: ComboboxItem.refine((item) => item !== null, {
    message: "Please select a product",
  }),
  location: ComboboxItem.refine((item) => item !== null, {
    message: "Please select a location",
  }),
  amountValue: z.string().min(1, "Please enter a value"),
  amountUnit: z.string().min(1, "Please enter a unit"),
});

export type InventoryFormValues = z.infer<typeof formSchema>;

// Define the props passed by parent for create operation
export type CreateInventoryData = z.infer<typeof inventoryCreatePayloadData>;

// Use the existing zod schema type for update
export type UpdateInventoryData = {
  id: string;
  data: z.infer<typeof inventoryUpdatePayloadData>;
};

// Base props shared by both modes
interface BaseInventoryFormProps {
  isPending: boolean;
  error?: string;
  onCancel?: () => void;
}

// Props for create mode
interface CreateInventoryFormProps extends BaseInventoryFormProps {
  mode: "create";
  onCreate: (data: CreateInventoryData) => void;
  onEdit?: never;
  inventoryItem?: never;
}

// Props for edit mode
interface EditInventoryFormProps extends BaseInventoryFormProps {
  mode: "edit";
  onEdit: (data: UpdateInventoryData) => void;
  onCreate?: never;
  inventoryItem: z.infer<typeof inventoryWithLocationAndProductOut>;
}

// Combined props type using discriminated union
type InventoryFormProps = CreateInventoryFormProps | EditInventoryFormProps;

export const InventoryForm: FC<InventoryFormProps> = (props) => {
  const { w } = useWasm();
  const { mode, isPending, error, onCancel } = props;

  // Initialize form with default values or existing inventory item data
  const form = useForm<InventoryFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      product: props.mode === "edit" && props.inventoryItem
        ? buildProductComboboxItem(props.inventoryItem.product)
        : undefined,
      location: props.mode === "edit" && props.inventoryItem
        ? buildLocationComboboxItem(props.inventoryItem.location)
        : undefined,
      amountValue: props.mode === "edit" && props.inventoryItem 
        ? props.inventoryItem.amount.value.toString() 
        : "",
      amountUnit: props.mode === "edit" && props.inventoryItem 
        ? props.inventoryItem.amount.unit 
        : "",
    },
  });

  // Fetch locations and products for dropdowns
  const [locations] = api.location.list.useSuspenseQuery({
    pagination: { pageIndex: 0, pageSize: 100 },
    sort: { orderBy: "name", direction: "asc" },
  });

  const findLocations = async (searchQuery: string) =>
    clientSideFilter(
      locations.items.map(buildLocationComboboxItem),
      searchQuery,
    );

  const [products] = api.product.list.useSuspenseQuery({
    pagination: { pageIndex: 0, pageSize: 100 },
    sort: { orderBy: "name", direction: "asc" },
  });

  const findProducts = async (searchQuery: string): Promise<ComboboxItem[]> =>
    clientSideFilter(products.items.map(buildProductComboboxItem), searchQuery);

  const handleSubmit = (values: InventoryFormValues) => {
    const amount: Amount = {
      value: parseFloat(values.amountValue),
      unit: values.amountUnit,
    };

    if (mode === "create") {
      // For creation, pass all fields
      const createData: CreateInventoryData = {
        productId: values.product!.id,
        locationId: values.location!.id,
        amount,
      };
      props.onCreate(createData);
    } else if (mode === "edit") {
      const inventoryItem = props.inventoryItem;
      // In edit mode, determine which fields have changed
      const updates: z.infer<typeof inventoryUpdatePayloadData> = {};

      // Check if amount has changed
      if (
        amount.value !== inventoryItem.amount.value ||
        amount.unit !== inventoryItem.amount.unit
      ) {
        updates.amount = amount;
      }

      // Check if product has changed
      if (values.product?.id !== inventoryItem.product.id) {
        updates.productId = values.product!.id;
      }

      // Check if location has changed
      if (values.location?.id !== inventoryItem.location.id) {
        updates.locationId = values.location!.id;
      }

      // Only update if there are changes
      if (Object.keys(updates).length > 0) {
        const updateData: UpdateInventoryData = {
          id: inventoryItem.id,
          data: updates,
        };
        props.onEdit(updateData);
      } else if (onCancel) {
        // If no changes, just run the cancel function
        onCancel();
      }
    }
  };

  if (!w) {
    return <div>Loading...</div>;
  }

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
          name="product"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Product</FormLabel>
              <FormControl>
                <Combobox
                  label="product"
                  findItems={findProducts}
                  value={field.value}
                  setValue={field.onChange}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="location"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Location</FormLabel>
              <FormControl>
                <Combobox
                  label="location"
                  findItems={findLocations}
                  value={field.value}
                  setValue={field.onChange}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="flex space-x-4">
          <FormField
            control={form.control}
            name="amountValue"
            render={({ field }) => (
              <FormItem className="flex-1">
                <FormLabel>Amount Value</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    step="0.01"
                    placeholder="Enter amount"
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="amountUnit"
            render={({ field }) => (
              <FormItem className="flex-1">
                <FormLabel>Amount Unit</FormLabel>
                <FormControl>
                  <Input type="text" placeholder="Enter unit" {...field} />
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