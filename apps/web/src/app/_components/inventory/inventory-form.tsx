"use client";
import { type FC } from "react";
import {
  buildProductComboboxItem,
  buildLocationComboboxItem,
} from "~/app/_components/combobox/combobox-builders";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { type inventoryWithLocationAndProductOut } from "~/schemas/combo";
import {
  inventoryCreatePayloadData,
  type InventoryUpdateInput,
  inventoryUpdatePayloadData,
} from "~/schemas/inventory";
import { type ProductId, type LocationId } from "~/schemas/identifiers";
import {
  type CreateModeProps,
  type EditModeProps,
  FormWrapper,
  ComboboxField,
  getSubmitButtonText,
  detectComboboxIdChange,
} from "../form-utils";
import { AmountFieldGroup } from "./amount-field-group";
import { ComboboxItem } from "../combobox/combobox-types";

import {
  WithLocationSearch,
  WithProductSearch,
} from "../combobox/with-search-hook";
import { amount } from "~/codec/codec";

// Form schema for inventory form
// Note: We use simple Zod schema for validation, TypeScript infers from Zod
const formSchema = z.object({
  product: ComboboxItem.refine((item) => item !== null, {
    message: "Please select a product",
  }),
  location: ComboboxItem.refine((item) => item !== null, {
    message: "Please select a location",
  }),
  amount: amount,
});

type InventoryFormValues = z.infer<typeof formSchema>;

// Props for create mode
interface CreateInventoryFormProps
  extends CreateModeProps<z.infer<typeof inventoryCreatePayloadData>> {
  inventoryItem?: never;
}

// Props for edit mode
interface EditInventoryFormProps
  extends EditModeProps<
    InventoryUpdateInput,
    z.infer<typeof inventoryWithLocationAndProductOut>
  > {
  entity: z.infer<typeof inventoryWithLocationAndProductOut>;
}

// Combined props type using discriminated union
type InventoryFormProps = CreateInventoryFormProps | EditInventoryFormProps;

export const InventoryForm: FC<InventoryFormProps> = (props) => {
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
      const createData: z.infer<typeof inventoryCreatePayloadData> = {
        productId: values.product!.id as ProductId,
        locationId: values.location!.id as LocationId,
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
        updates.productId = productIdChange as ProductId;
      }
      const locationIdChange = detectComboboxIdChange(
        inventoryItem.location.id,
        values.location,
      );
      if (locationIdChange) {
        updates.locationId = locationIdChange as LocationId;
      }
      if (Object.keys(updates).length > 0) {
        const updateData: InventoryUpdateInput = {
          id: inventoryItem.id,
          data: updates,
        };
        props.onEdit(updateData);
      } else if (onCancel) {
        onCancel();
      }
    }
  };

  // We know w is always defined now with our updated useWasm hook

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

      <AmountFieldGroup
        form={form}
        valuePath="amount.value"
        unitPath="amount.unit"
      />
    </FormWrapper>
  );
};
