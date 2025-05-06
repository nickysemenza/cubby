"use client";
import { useWasm } from "~/wasmContext";
import { type FC } from "react";
import { ComboboxItem } from "~/app/_components/combobox/combobox-types";
import {
  buildProductComboboxItem,
  buildLocationComboboxItem,
} from "~/app/_components/combobox/utils";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { type inventoryWithLocationAndProductOut } from "~/schemas/combo";
import {
  inventoryCreatePayloadData,
  inventoryUpdatePayloadData,
} from "~/schemas/inventory";
import {
  type CreateModeProps,
  type EditModeProps,
  FormWrapper,
  ComboboxField,
  NumericField,
  RequiredTextField,
  getSubmitButtonText,
  SideBySideFields,
  detectComboboxIdChange,
  hasAmountChanged,
  createAmountObject,
} from "../form-utils";

import {
  WithLocationSearch,
  WithProductSearch,
} from "../combobox/with-search-hook";

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

// Props for create mode
interface CreateInventoryFormProps
  extends CreateModeProps<CreateInventoryData> {
  inventoryItem?: never;
}

// Props for edit mode
interface EditInventoryFormProps
  extends EditModeProps<
    UpdateInventoryData,
    z.infer<typeof inventoryWithLocationAndProductOut>
  > {
  entity: z.infer<typeof inventoryWithLocationAndProductOut>;
}

// Combined props type using discriminated union
type InventoryFormProps = CreateInventoryFormProps | EditInventoryFormProps;

export const InventoryForm: FC<InventoryFormProps> = (props) => {
  const { w } = useWasm();
  const { mode, isPending, error, onCancel } = props;

  // Get the inventory item in edit mode
  const inventoryItem = mode === "edit" ? props.entity : undefined;

  // Initialize form with default values or existing inventory item data
  const form = useForm<InventoryFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      product: inventoryItem
        ? buildProductComboboxItem(inventoryItem.product)
        : undefined,
      location: inventoryItem
        ? buildLocationComboboxItem(inventoryItem.location)
        : undefined,
      amountValue: inventoryItem ? inventoryItem.amount.value.toString() : "",
      amountUnit: inventoryItem ? inventoryItem.amount.unit : "",
    },
  });

  const handleSubmit = (values: InventoryFormValues) => {
    // Convert the form values to an Amount object
    const amount = createAmountObject({
      value: values.amountValue,
      unit: values.amountUnit,
    });

    if (mode === "create") {
      // For creation, pass all fields
      const createData: CreateInventoryData = {
        productId: values.product!.id,
        locationId: values.location!.id,
        amount,
      };
      props.onCreate(createData);
    } else if (mode === "edit" && inventoryItem) {
      // In edit mode, determine which fields have changed
      const updates: z.infer<typeof inventoryUpdatePayloadData> = {};

      // Check if amount has changed using shared utility
      if (
        hasAmountChanged(
          inventoryItem.amount,
          values.amountValue,
          values.amountUnit,
        )
      ) {
        updates.amount = amount;
      }

      // Check if product has changed using shared utility
      const productIdChange = detectComboboxIdChange(
        inventoryItem.product.id,
        values.product,
      );
      if (productIdChange) {
        updates.productId = productIdChange;
      }

      // Check if location has changed using shared utility
      const locationIdChange = detectComboboxIdChange(
        inventoryItem.location.id,
        values.location,
      );
      if (locationIdChange) {
        updates.locationId = locationIdChange;
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
      <WithProductSearch>
        {({ findItems, onCreateNew }) => (
          <ComboboxField
            form={form}
            name="product"
            label="Product"
            findItems={findItems}
            onCreateNew={onCreateNew}
          />
        )}
      </WithProductSearch>

      <WithLocationSearch>
        {({ findItems, onCreateNew }) => (
          <ComboboxField
            form={form}
            name="location"
            label="Location"
            findItems={findItems}
            onCreateNew={onCreateNew}
          />
        )}
      </WithLocationSearch>

      <SideBySideFields>
        <NumericField
          form={form}
          name="amountValue"
          label="Amount Value"
          placeholder="Enter amount"
        />

        <RequiredTextField
          form={form}
          name="amountUnit"
          label="Amount Unit"
          placeholder="Enter unit"
        />
      </SideBySideFields>
    </FormWrapper>
  );
};
