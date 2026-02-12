import { unsafeInventoryId } from "@cubby/schemas/identifiers";
import type { InventoryBulkOperationItem } from "@cubby/schemas/inventory";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Plus, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { toast } from "sonner";
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
import {
  ComboboxFieldWithSearch,
  FormWrapper,
  getSubmitButtonText,
} from "~/app/_components/form-utils";
import { AmountFieldGroup } from "~/app/_components/inventory/amount-field-group";
import { BarcodeScannerButton } from "~/app/_components/inventory/barcode-scanner-button";
import { useUpcLookup } from "~/app/_components/inventory/hooks";
import { Button } from "~/components/ui/button";
import { useTRPC } from "~/trpc/react";

// Schema for a single inventory item using shared field schemas
const inventoryItemSchema = z.object({
  product: requiredProductField,
  amount: amountField,
  id: z.string().optional(), // For existing items
});

// Schema for the entire form
const formSchema = z.object({
  location: requiredLocationField,
  items: z.array(inventoryItemSchema),
});

type BulkInventoryFormValues = z.input<typeof formSchema>;

export default function BulkInventoryForm() {
  const api = useTRPC();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  // Initialize the form
  const form = useForm<BulkInventoryFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      location: undefined,
      items: [],
    },
  });

  // Set up the field array for inventory items
  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "items",
  });

  // Watch the location field to load items when changed
  const selectedLocation = form.watch("location");

  // Fetch locations for the location selector
  const { data: locationsResp } = useQuery(
    api.location.list.queryOptions({
      pagination: { pageIndex: 0, pageSize: 100 },
      sort: { orderBy: "name", direction: "asc" },
      filters: {},
    }),
  );

  const locations = useMemo(() => locationsResp?.items || [], [locationsResp]);

  // Update URL when location changes
  useEffect(() => {
    if (selectedLocation) {
      const currentParams = new URLSearchParams(window.location.search);
      const currentLocationId = currentParams.get("locationId");
      // Only update URL if it's different to avoid infinite loop
      if (currentLocationId !== selectedLocation.id) {
        currentParams.set("locationId", selectedLocation.id);
        navigate({
          to: `/inventory/bulk-edit?${currentParams.toString()}`,
          replace: true,
        });
      }
    }
  }, [selectedLocation, navigate]);

  // Set initial location from URL
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const locationId = params.get("locationId");
    if (locationId && locations.length > 0) {
      const location = locations.find((loc) => loc.id === locationId);
      if (location) {
        form.setValue("location", buildLocationComboboxItem(location));
      }
    }
  }, [locations, form]);

  // Fetch existing inventory items when location is selected
  const { data: inventoryItemsData, refetch: refetchInventoryItems } = useQuery(
    {
      ...api.inventory.list.queryOptions({
        sort: { orderBy: "createdAt", direction: "desc" },
        pagination: { pageIndex: 0, pageSize: 100 },
        filters: { locationIdFilter: selectedLocation?.id ?? "" },
      }),
      enabled: !!selectedLocation,
    },
  );

  // Load existing inventory items when location changes
  useEffect(() => {
    if (selectedLocation && inventoryItemsData?.items) {
      form.setValue("items", []);
      const existingItems: z.infer<typeof inventoryItemSchema>[] =
        inventoryItemsData.items.map((item) => ({
          product: buildProductComboboxItem(item.product),
          amount: item.amount,
          id: item.id,
        }));
      form.setValue("items", existingItems);
    } else {
      form.setValue("items", []);
    }
  }, [selectedLocation, inventoryItemsData, form]);

  // Add a new empty inventory item
  const addInventoryItem = () => {
    append({
      product: null,
      amount: { value: 1, unit: "" },
    });
  };

  // Bulk process mutation
  const bulkProcessMutation = useMutation(
    api.inventory.bulkProcess.mutationOptions({
      onSuccess: () => {
        refetchInventoryItems();
      },
    }),
  );

  // UPC lookup for barcode scanning
  const { lookupUpc, isPending: isUpcPending } = useUpcLookup();

  // Handle barcode scan for a specific item index
  const handleBarcodeScan = useCallback(
    async (barcode: string, index: number) => {
      const product = await lookupUpc(barcode);
      if (product) {
        form.setValue(
          `items.${index}.product`,
          buildProductComboboxItem(product),
        );
        toast.success(`Found: ${product.name}`);
      }
    },
    [lookupUpc, form],
  );

  // Submit handler
  const onSubmit = async (values: BulkInventoryFormValues) => {
    const location = values.location;
    if (!location) {
      setError("Please select a location");
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      const validItems = values.items.filter(
        (
          item,
        ): item is typeof item & {
          product: NonNullable<typeof item.product>;
        } =>
          item.product !== null &&
          item.amount.value !== null &&
          item.amount.unit !== "",
      );
      const locationId = getLocationId(location);
      const processItems: InventoryBulkOperationItem[] = validItems.map(
        (item) => {
          const res: InventoryBulkOperationItem = {
            locationId,
            ...(item.id && { id: unsafeInventoryId(item.id) }),
            productId: getProductId(item.product),
            amount: item.amount,
          };
          return res;
        },
      );
      await bulkProcessMutation.mutateAsync({
        locationId,
        items: processItems,
      });
      toast.success(`Successfully updated inventory for ${location.name}`);
      setIsSubmitting(false);
    } catch (err) {
      console.error("Error submitting inventory items:", err);
      setError("Failed to update inventory. Please try again.");
      setIsSubmitting(false);
    }
  };

  return (
    <FormWrapper
      form={form}
      onSubmit={onSubmit}
      error={error ?? undefined}
      isPending={isSubmitting}
      submitButtonText={getSubmitButtonText("edit")}
    >
      <div className="mb-6 max-w-md">
        <ComboboxFieldWithSearch
          form={form}
          name="location"
          label="Location"
          searchType="location"
        />
      </div>

      {selectedLocation && (
        <>
          <div className="mb-4 flex items-center justify-between">
            <h3 className="font-medium text-lg">
              Inventory for {selectedLocation.name}
            </h3>
            <Button type="button" onClick={addInventoryItem} size="sm">
              <Plus className="mr-1 h-4 w-4" />
              Add Item
            </Button>
          </div>

          <div className="space-y-2">
            {fields.length > 0 ? (
              fields.map((field, index) => (
                <div
                  key={field.id}
                  className="flex items-center gap-2 rounded border p-1"
                >
                  <div className="flex-1">
                    <ComboboxFieldWithSearch
                      form={form}
                      name={`items.${index}.product`}
                      label="Product"
                      searchType="product"
                    />
                  </div>

                  <div className="w-64">
                    <AmountFieldGroup
                      form={form}
                      valuePath={`items.${index}.amount.value`}
                      unitPath={`items.${index}.amount.unit`}
                    />
                  </div>

                  <BarcodeScannerButton
                    onScan={(barcode) => handleBarcodeScan(barcode, index)}
                    disabled={isUpcPending}
                  />

                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => remove(index)}
                    className="shrink-0"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ))
            ) : (
              <div className="py-4 text-center text-muted-foreground">
                No inventory items yet.
              </div>
            )}
          </div>
        </>
      )}
    </FormWrapper>
  );
}
