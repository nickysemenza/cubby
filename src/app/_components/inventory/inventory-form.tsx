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
  getSubmitButtonText,
  SideBySideFields,
  detectComboboxIdChange,
  NullableNumericField,
  UnifiedTextField,
} from "../form-utils";

import {
  WithLocationSearch,
  WithProductSearch,
} from "../combobox/with-search-hook";
import { amount } from "~/codec/codec";

// Form schema for inventory form
const formSchema = z.object({
  product: ComboboxItem.refine((item) => item !== null, {
    message: "Please select a product",
  }),
  location: ComboboxItem.refine((item) => item !== null, {
    message: "Please select a location",
  }),
  amount: amount,
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
      amount: inventoryItem ? inventoryItem.amount : { value: 1, unit: "" },
    },
  });

  const handleSubmit = (values: InventoryFormValues) => {
    const amount = values.amount;
    if (mode === "create") {
      const createData: CreateInventoryData = {
        productId: values.product!.id,
        locationId: values.location!.id,
        amount,
      };
      props.onCreate(createData);
    } else if (mode === "edit" && inventoryItem) {
      const updates: z.infer<typeof inventoryUpdatePayloadData> = {};
      if (
        values.amount.value !== inventoryItem.amount.value ||
        values.amount.unit !== inventoryItem.amount.unit
      ) {
        updates.amount = amount;
      }
      const productIdChange = detectComboboxIdChange(
        inventoryItem.product.id,
        values.product,
      );
      if (productIdChange) {
        updates.productId = productIdChange;
      }
      const locationIdChange = detectComboboxIdChange(
        inventoryItem.location.id,
        values.location,
      );
      if (locationIdChange) {
        updates.locationId = locationIdChange;
      }
      if (Object.keys(updates).length > 0) {
        const updateData: UpdateInventoryData = {
          id: inventoryItem.id,
          data: updates,
        };
        props.onEdit(updateData);
      } else if (onCancel) {
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
        <NullableNumericField
          form={form}
          name="amount.value"
          label="Amount Value"
          placeholder="Enter amount"
        />
        <UnifiedTextField
          form={form}
          name="amount.unit"
          label="Amount Unit"
          placeholder="Enter unit"
          nullable={false}
        />
      </SideBySideFields>
    </FormWrapper>
  );
};
