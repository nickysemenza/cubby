"use client";
import { useState, useEffect, useMemo } from "react";
import { useForm, useFieldArray, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTRPC } from "~/trpc/react";
import { ComboboxItem, clientSideFilter } from "~/app/_components/combobox";
import {
  buildProductComboboxItem,
  buildLocationComboboxItem,
} from "~/app/_components/combobox/utils";
import { Button } from "~/components/ui/button";
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from "~/components/ui/form";
import { Input } from "~/components/ui/input";
import { Combobox } from "~/app/_components/combobox";
import { DevTool } from "@hookform/devtools";
import { X, Plus } from "lucide-react";
import { useWasm } from "~/wasmContext";
import { createAmountObject } from "~/app/_components/form-utils";
import { toast } from "react-toastify";
import { InventoryBulkOperationItem } from "~/schemas/inventory";
import { useRouter, useSearchParams } from "next/navigation";

import { useQuery } from "@tanstack/react-query";
import { useMutation } from "@tanstack/react-query";

// Schema for a single inventory item
const inventoryItemSchema = z.object({
  product: ComboboxItem.refine((item) => item !== null, {
    message: "Please select a product",
  }),
  amountValue: z.string().min(1, "Please enter a value"),
  amountUnit: z.string().min(1, "Please enter a unit"),
  id: z.string().optional(), // For existing items
});

// Schema for the entire form
const formSchema = z.object({
  location: ComboboxItem.refine((item) => item !== null, {
    message: "Please select a location",
  }),
  items: z.array(inventoryItemSchema),
});

type BulkInventoryFormValues = z.infer<typeof formSchema>;

export default function BulkInventoryForm() {
  const api = useTRPC();
  const { w } = useWasm();
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
      const params = new URLSearchParams(searchParams.toString());
      params.set("locationId", selectedLocation.id);
      router.push(`/inventory/bulk-edit?${params.toString()}`);
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

  // Fetch products for the product dropdown
  const { data: productsResp } = useQuery(
    api.product.list.queryOptions({
      pagination: { pageIndex: 0, pageSize: 100 },
      sort: { orderBy: "name", direction: "asc" },
      filters: {},
    }),
  );

  const products = productsResp?.items || [];

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
      // Clear current items first
      form.setValue("items", []);

      // Convert existing inventory items to form field values
      const existingItems = inventoryItemsData.items.map((item) => ({
        product: buildProductComboboxItem(item.product),
        amountValue: item.amount.value.toString(),
        amountUnit: item.amount.unit,
        id: item.id,
      }));

      // Replace the items with existing ones
      form.setValue("items", existingItems);
    } else {
      // Clear items if no location selected
      form.setValue("items", []);
    }
  }, [selectedLocation, inventoryItemsData, form]);

  // Lookup functions for comboboxes
  const findLocations = async (searchQuery: string) =>
    clientSideFilter(locations.map(buildLocationComboboxItem), searchQuery);

  const findProducts = async (searchQuery: string): Promise<ComboboxItem[]> =>
    clientSideFilter(products.map(buildProductComboboxItem), searchQuery);

  // Add a new empty inventory item
  const addInventoryItem = () => {
    append({
      product: null as unknown as ComboboxItem,
      amountValue: "",
      amountUnit: "",
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
    if (!values.location) {
      setError("Please select a location");
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      // Filter out any incomplete items
      const validItems = values.items.filter(
        (item) => item.product && item.amountValue && item.amountUnit,
      );

      // Transform items for the API
      const processItems: InventoryBulkOperationItem[] = validItems.map(
        (item) => {
          const amount = createAmountObject({
            value: item.amountValue,
            unit: item.amountUnit,
          });

          const res: InventoryBulkOperationItem = {
            locationId: values.location.id,
            // Include id only for existing items
            ...(item.id && { id: item.id }),
            productId: item.product.id,
            amount,
          };
          return res;
        },
      );

      // Submit all items in a single bulk operation
      await bulkProcessMutation.mutateAsync({
        locationId: values.location.id,
        items: processItems,
      });

      // Show success message
      toast(`Successfully updated inventory for ${values.location.name}`);

      setIsSubmitting(false);
    } catch (err) {
      console.error("Error submitting inventory items:", err);
      setError("Failed to update inventory. Please try again.");
      setIsSubmitting(false);
    }
  };

  if (!w) {
    return <div>Loading...</div>;
  }

  return (
    <Form {...form}>
      <DevTool control={form.control} />
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
        <div className="mb-6 max-w-md">
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
                      <Controller
                        control={form.control}
                        name={`items.${index}.product`}
                        render={({ field }) => (
                          <FormItem>
                            <Combobox
                              label="product"
                              findItems={findProducts}
                              value={field.value}
                              setValue={field.onChange}
                            />
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>

                    <div className="w-24">
                      <Controller
                        control={form.control}
                        name={`items.${index}.amountValue`}
                        render={({ field }) => (
                          <FormItem>
                            <Input
                              type="number"
                              step="0.01"
                              placeholder="Value"
                              {...field}
                            />
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>

                    <div className="w-24">
                      <Controller
                        control={form.control}
                        name={`items.${index}.amountUnit`}
                        render={({ field }) => (
                          <FormItem>
                            <Input placeholder="Unit" {...field} />
                            <FormMessage />
                          </FormItem>
                        )}
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
                <div className="py-4 text-center text-gray-500">
                  No inventory items yet.
                </div>
              )}
            </div>
          </>
        )}

        {error && <div className="mt-4 text-red-500">{error}</div>}

        <div className="flex justify-end">
          <Button
            type="submit"
            disabled={
              isSubmitting ||
              !selectedLocation ||
              (!form.formState.isDirty && fields.length === 0)
            }
          >
            {isSubmitting ? "Saving..." : "Save All Changes"}
          </Button>
        </div>
      </form>
    </Form>
  );
}
