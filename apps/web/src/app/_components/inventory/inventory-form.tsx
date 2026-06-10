import type { inventoryWithLocationAndProductOut } from "@cubby/schemas/combo";
import type { LocationId, ProductId } from "@cubby/schemas/identifiers";
import type {
  InventoryUpdateInput,
  inventoryCreatePayloadData,
  inventoryUpdatePayloadData,
} from "@cubby/schemas/inventory";
import { zodResolver } from "@hookform/resolvers/zod";
import type { FC } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import {
  buildLocationComboboxItem,
  buildProductComboboxItem,
} from "~/app/_components/combobox/combobox-builders";
import {
  amountField,
  getLocationId,
  getProductId,
  requiredLocationField,
  requiredProductField,
} from "~/app/_components/form-fields";
import { Card, CardContent } from "~/components/ui/card";
import {
  ComboboxFieldWithSearch,
  type CreateModeProps,
  detectComboboxIdChange,
  type EditModeProps,
  FormWrapper,
  getSubmitButtonText,
  SideBySideFields,
  submitOrCancel,
} from "../form-utils";
import { AmountFieldGroup } from "./amount-field-group";

// Form schema using shared field schemas
const formSchema = z.object({
  product: requiredProductField,
  location: requiredLocationField,
  amount: amountField,
});

type InventoryFormValues = z.input<typeof formSchema>;

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
        productId: getProductId(values.product),
        locationId: getLocationId(values.location),
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
      const productIdChange = detectComboboxIdChange<ProductId>(
        inventoryItem.product.id,
        values.product,
      );
      if (productIdChange) {
        updates.productId = productIdChange;
      }
      const locationIdChange = detectComboboxIdChange<LocationId>(
        inventoryItem.location.id,
        values.location,
      );
      if (locationIdChange) {
        updates.locationId = locationIdChange;
      }
      submitOrCancel(
        updates,
        () => ({ id: inventoryItem.id, data: updates }),
        props.onEdit,
        onCancel,
      );
    }
  };

  const buttonText = getSubmitButtonText(mode);

  return (
    <FormWrapper
      form={form}
      onSubmit={handleSubmit}
      error={error}
      isPending={isPending}
      onCancel={onCancel}
      submitButtonText={buttonText}
    >
      <Card emphasis="chunky">
        <CardContent className="space-y-2 px-4 py-1">
          <SideBySideFields>
            <ComboboxFieldWithSearch
              form={form}
              name="product"
              label="Product"
              searchType="product"
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
