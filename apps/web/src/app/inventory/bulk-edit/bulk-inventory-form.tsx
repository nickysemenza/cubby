"use client";
import { useState, useEffect, useMemo } from "react";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTRPC } from "~/trpc/react";
import { ComboboxItem as ComboboxItemSchema } from "~/app/_components/combobox/combobox-types";
import {
  buildProductComboboxItem,
  buildLocationComboboxItem,
} from "~/app/_components/combobox/combobox-builders";
import { Button } from "~/components/ui/button";
import { X, Plus } from "lucide-react";
import { toast } from "sonner";
import { InventoryBulkOperationItem } from "~/schemas/inventory";
import { type LocationId, type ProductId } from "~/schemas/identifiers";
import { useRouter, useSearchParams } from "next/navigation";

import { useQuery } from "@tanstack/react-query";
import { useMutation } from "@tanstack/react-query";
import {
  ComboboxFieldWithSearch,
  FormWrapper,
  getSubmitButtonText,
} from "~/app/_components/form-utils";
import { amount } from "~/codec/codec";
import { AmountFieldGroup } from "~/app/_components/inventory/amount-field-group";

// Schema for a single inventory item
const inventoryItemSchema = z.object({
  product: ComboboxItemSchema.nullable().refine((item) => item !== null, {
    message: "Please select a product",
  }),
  amount: amount,
  id: z.string().optional(), // For existing items
});

// Schema for the entire form
const formSchema = z.object({
  location: ComboboxItemSchema.nullable().refine((item) => item !== null, {
    message: "Please select a location",
  }),
  items: z.array(inventoryItemSchema),
});

type BulkInventoryFormValues = z.infer<typeof formSchema>;

export default function BulkInventoryForm() {
  const api = useTRPC();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const searchParams = useSearchParams();

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
  // eslint-disable-next-line react-hooks/incompatible-library -- React Hook Form API limitation
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
      const currentLocationId = searchParams.get("locationId");
      // Only update URL if it's different to avoid infinite loop
      if (currentLocationId !== selectedLocation.id) {
        const params = new URLSearchParams(searchParams.toString());
        params.set("locationId", selectedLocation.id);
        router.replace(`/inventory/bulk-edit?${params.toString()}`);
      }
    }
  }, [selectedLocation, router, searchParams]);

  // Set initial location from URL
  useEffect(() => {
    const locationId = searchParams.get("locationId");
    if (locationId && locations.length > 0) {
      const location = locations.find((loc) => loc.id === locationId);
      if (location) {
        form.setValue("location", buildLocationComboboxItem(location));
      }
    }
  }, [searchParams, locations, form]);

  // Fetch existing inventory items when location is selected
  const { data: inventoryItemsData, refetch: refetchInventoryItems } = useQuery(
    api.inventoryItem.list.queryOptions(
      {
        sort: { orderBy: "createdAt", direction: "desc" },
        pagination: { pageIndex: 0, pageSize: 100 },
        filters: { locationIdFilter: selectedLocation?.id },
      },
      {
        enabled: !!selectedLocation,
      },
    ),
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
    api.inventoryItem.bulkProcess.mutationOptions({
      onSuccess: () => {
        refetchInventoryItems();
      },
    }),
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
      const processItems: InventoryBulkOperationItem[] = validItems.map(
        (item) => {
          const res: InventoryBulkOperationItem = {
            locationId: location.id as LocationId,
            ...(item.id && { id: item.id }),
            productId: item.product.id as ProductId,
            amount: item.amount,
          };
          return res;
        },
      );
      await bulkProcessMutation.mutateAsync({
        locationId: location.id as LocationId,
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

  // We know w is always defined now with our updated useWasm hook

  return (
    <FormWrapper
      form={form}
      onSubmit={onSubmit}
      error={error ?? undefined}
      isPending={isSubmitting}
      submitButtonText={getSubmitButtonText("edit", isSubmitting)}
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
            <h3 className="text-lg font-medium">
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

                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => remove(index)}
                    className="flex-shrink-0"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ))
            ) : (
              <div className="text-muted-foreground py-4 text-center">
                No inventory items yet.
              </div>
            )}
          </div>
        </>
      )}
    </FormWrapper>
  );
}
