import type {
  InventoryUpdateInput,
  inventoryCreatePayloadData,
  inventoryWithLocationAndProductOut,
} from "@cubby/schemas/inventory";
import type { FC } from "react";
import type { z } from "zod";

import { buildLocationComboboxItem } from "~/app/_components/combobox/combobox-builders";
import {
  getLocationId,
  getProductShortcode,
  inventoryItemWithLocationFields,
} from "~/app/_components/form-fields";
import { Card, CardContent } from "~/components/ui/card";
import { useEntityFormController } from "~/entities/editing/use-entity-form-controller";

import {
  type EntityFormProps,
  FormWrapper,
  SideBySideFields,
} from "../form-utils";
import { ComboboxFieldWithSearch } from "../form-utils/combobox-field-with-search";
import { AmountFieldGroup, DEFAULT_AMOUNT_UNIT } from "./amount-field-group";

// Module-level so `useEntityFormController`'s resolver memoization sees a
// stable reference across renders (never a fresh inline array). "placement"
// (also on the generated model) has no UI here, so it's left out of the
// roster entirely rather than defaulting to the `full` edit intent.
const INVENTORY_FORM_FIELDS = ["productId", "locationId", "amount"] as const;

// TYPE-ONLY reuse of the shared field schemas — `inventoryItemWithLocationFields`
// (`~/app/_components/form-fields`) still describes this form's shape for RHF's
// generics; the actual resolver now comes from `useEntityFormController`.
type InventoryFormValues = z.input<typeof inventoryItemWithLocationFields>;

type InventoryFormProps = EntityFormProps<
  z.infer<typeof inventoryCreatePayloadData>,
  InventoryUpdateInput,
  z.infer<typeof inventoryWithLocationAndProductOut>
> & { inventoryItem?: never };

export const InventoryForm: FC<InventoryFormProps> = (props) => {
  const { mode, onCancel } = props;

  // Get the inventory item in edit mode
  const inventoryItem = mode === "edit" ? props.entity : undefined;

  const controller = useEntityFormController<
    "inventory",
    InventoryFormValues,
    z.infer<typeof inventoryWithLocationAndProductOut>,
    z.infer<typeof inventoryCreatePayloadData>,
    InventoryUpdateInput
  >("inventory", props, {
    fields: INVENTORY_FORM_FIELDS,
    defaultValues: {
      product: inventoryItem
        ? {
            id: inventoryItem.product.id,
            name: `${inventoryItem.product.name} (${inventoryItem.product.manufacturer})`,
          }
        : undefined,
      location: inventoryItem
        ? buildLocationComboboxItem(inventoryItem.location)
        : undefined,
      amount: inventoryItem
        ? inventoryItem.amount
        : { value: 1, unit: DEFAULT_AMOUNT_UNIT },
    },
    transform: {
      create: (values) => ({
        productId: getProductShortcode(values.product),
        locationId: getLocationId(values.location),
        amount: values.amount,
      }),
      edit: (updates) => ({ id: inventoryItem!.id, data: updates }),
    },
  });
  const { form, handleSubmit, isPending, error, submitButtonText } = controller;

  return (
    <FormWrapper
      form={form}
      onSubmit={handleSubmit}
      error={error}
      isPending={isPending}
      onCancel={onCancel}
      submitButtonText={submitButtonText}
    >
      <Card>
        <CardContent className="space-y-2 px-4 py-1">
          <SideBySideFields>
            <ComboboxFieldWithSearch
              form={form}
              name="product"
              label="Product"
              searchType="product"
              productIntent="stock"
            />
            <ComboboxFieldWithSearch
              form={form}
              name="location"
              label="Location"
              searchType="location"
            />
          </SideBySideFields>

          <AmountFieldGroup
            form={form}
            valuePath="amount.value"
            unitPath="amount.unit"
          />
        </CardContent>
      </Card>
    </FormWrapper>
  );
};
