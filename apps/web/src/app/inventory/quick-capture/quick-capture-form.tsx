"use client";

import { useState, useEffect, useCallback } from "react";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTRPC } from "~/trpc/react";
import { ComboboxItem as ComboboxItemSchema } from "~/app/_components/combobox/combobox-types";
import { buildProductComboboxItem } from "~/app/_components/combobox/combobox-builders";
import { Button } from "~/components/ui/button";
import { X, Plus } from "lucide-react";
import { toast } from "sonner";
import { type LocationId, type ProductId } from "~/schemas/identifiers";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ComboboxFieldWithSearch,
  FormWrapper,
  getSubmitButtonText,
} from "~/app/_components/form-utils";
import { queryKeys } from "~/lib/query-keys";
import { amount } from "~/codec/codec";
import { AmountFieldGroup } from "~/app/_components/inventory/amount-field-group";
import { WithProductSearchQuickCreate } from "~/app/_components/combobox/with-search-hook";
import { ComboboxField } from "~/app/_components/form-utils";
import { BarcodeScannerButton } from "~/app/_components/inventory/barcode-scanner-button";

// Schema for a single inventory item (now includes location per item)
const quickCaptureItemSchema = z.object({
  location: ComboboxItemSchema.nullable().refine((item) => item !== null, {
    message: "Please select a location",
  }),
  product: ComboboxItemSchema.nullable().refine((item) => item !== null, {
    message: "Please select a product",
  }),
  amount: amount,
});

// Schema for the entire form
const quickCaptureFormSchema = z.object({
  items: z.array(quickCaptureItemSchema),
});

type QuickCaptureFormValues = z.infer<typeof quickCaptureFormSchema>;

export default function QuickCaptureForm() {
  const api = useTRPC();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  // Initialize the form
  const form = useForm<QuickCaptureFormValues>({
    resolver: zodResolver(quickCaptureFormSchema),
    defaultValues: {
      items: [
        { location: null, product: null, amount: { value: 1, unit: "each" } },
      ],
    },
  });

  // Set up the field array for inventory items
  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "items",
  });

  // Watch items to get the last location for copying
  const items = form.watch("items");

  // Add a new empty inventory item, copying location from previous row
  const addInventoryItem = useCallback(() => {
    const lastItem = items[items.length - 1];
    const lastLocation = lastItem?.location ?? null;
    append({
      location: lastLocation,
      product: null,
      amount: { value: 1, unit: "each" },
    });
  }, [append, items]);

  // Bulk process mutation
  const bulkProcessMutation = useMutation(
    api.inventoryItem.bulkProcess.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: queryKeys.inventoryItem.list,
        });
      },
    }),
  );

  // Find or create product by UPC
  const findOrCreateByUPCMutation = useMutation(
    api.product.findOrCreateByUPC.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: queryKeys.product.list });
      },
    }),
  );

  // Handle barcode scan for a specific item index
  const handleBarcodeScan = useCallback(
    async (barcode: string, index: number) => {
      try {
        const product = await findOrCreateByUPCMutation.mutateAsync({
          upc: barcode,
        });
        form.setValue(
          `items.${index}.product`,
          buildProductComboboxItem(product),
        );
        toast.success(`Found: ${product.name}`);
      } catch (err) {
        console.error("Barcode lookup failed:", err);
        toast.error("Failed to look up barcode");
      }
    },
    [findOrCreateByUPCMutation, form],
  );

  // Submit handler
  const onSubmit = useCallback(
    async (values: QuickCaptureFormValues) => {
      setError(null);

      const validItems = values.items.filter(
        (
          item,
        ): item is typeof item & {
          location: NonNullable<typeof item.location>;
          product: NonNullable<typeof item.product>;
        } =>
          item.location !== null &&
          item.product !== null &&
          item.amount.value !== null &&
          item.amount.unit !== "",
      );

      if (validItems.length === 0) {
        setError("Please add at least one item with location and product");
        return;
      }

      setIsSubmitting(true);
      try {
        // Group items by location for efficient processing
        const itemsByLocation = new Map<
          string,
          Array<{
            productId: ProductId;
            amount: { value: number; unit: string };
          }>
        >();

        for (const item of validItems) {
          const locationId = item.location.id;
          if (!itemsByLocation.has(locationId)) {
            itemsByLocation.set(locationId, []);
          }
          itemsByLocation.get(locationId)!.push({
            productId: item.product.id as ProductId,
            amount: item.amount,
          });
        }

        // Process each location's items
        for (const [locationId, locationItems] of itemsByLocation) {
          await bulkProcessMutation.mutateAsync({
            locationId: locationId as LocationId,
            items: locationItems.map((item) => ({
              locationId: locationId as LocationId,
              productId: item.productId,
              amount: item.amount,
            })),
          });
        }

        // Get unique location names for success message
        const locationNames = [
          ...new Set(validItems.map((item) => item.location.name)),
        ];
        const locationText =
          locationNames.length === 1
            ? locationNames[0]
            : `${locationNames.length} locations`;

        toast.success(
          `Successfully added ${validItems.length} item(s) to ${locationText}`,
        );

        // Reset form, keeping the last location for convenience
        const lastLocation =
          validItems[validItems.length - 1]?.location ?? null;
        form.setValue("items", [
          {
            location: lastLocation,
            product: null,
            amount: { value: 1, unit: "each" },
          },
        ]);
      } catch (err) {
        console.error("Error submitting inventory items:", err);
        setError("Failed to update inventory. Please try again.");
      } finally {
        setIsSubmitting(false);
      }
    },
    [bulkProcessMutation, form],
  );

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl/Cmd + Enter to submit
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        form.handleSubmit(onSubmit)();
      }
      // Ctrl/Cmd + N to add new item
      if ((e.ctrlKey || e.metaKey) && e.key === "n") {
        e.preventDefault();
        addInventoryItem();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [form, addInventoryItem, onSubmit]);

  return (
    <FormWrapper
      form={form}
      onSubmit={onSubmit}
      error={error ?? undefined}
      isPending={isSubmitting}
      submitButtonText={getSubmitButtonText("create", isSubmitting)}
    >
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-lg font-medium">Quick Inventory Capture</h3>
        <Button type="button" onClick={addInventoryItem} size="sm">
          <Plus className="mr-1 h-4 w-4" />
          Add Item (Ctrl+N)
        </Button>
      </div>

      <div className="space-y-2">
        {fields.map((field, index) => (
          <div
            key={field.id}
            className="flex items-start gap-2 rounded border p-2"
          >
            <div className="w-48 flex-shrink-0">
              <ComboboxFieldWithSearch
                form={form}
                name={`items.${index}.location`}
                label={index === 0 ? "Location" : undefined}
                searchType="location"
              />
            </div>

            <div className="min-w-0 flex-1">
              <WithProductSearchQuickCreate>
                {({ items, onSearchChange, isLoading, onCreateNew }) => (
                  <ComboboxField
                    form={form}
                    name={`items.${index}.product`}
                    label={index === 0 ? "Product" : undefined}
                    items={items}
                    onSearchChange={onSearchChange}
                    isLoading={isLoading}
                    onCreateNew={onCreateNew}
                  />
                )}
              </WithProductSearchQuickCreate>
            </div>

            <div className="w-36 flex-shrink-0">
              <AmountFieldGroup
                form={form}
                valuePath={`items.${index}.amount.value`}
                unitPath={`items.${index}.amount.unit`}
              />
            </div>

            <div className={`flex gap-1 ${index === 0 ? "mt-6" : ""}`}>
              <BarcodeScannerButton
                onScan={(barcode) => handleBarcodeScan(barcode, index)}
                disabled={findOrCreateByUPCMutation.isPending}
              />

              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => {
                  if (fields.length > 1) {
                    remove(index);
                  }
                }}
                disabled={fields.length <= 1}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
        ))}
      </div>

      <div className="text-muted-foreground mt-4 text-sm">
        <p>Keyboard shortcuts:</p>
        <ul className="list-inside list-disc">
          <li>
            <kbd className="bg-muted rounded px-1">Ctrl+Enter</kbd> - Save all
            items
          </li>
          <li>
            <kbd className="bg-muted rounded px-1">Ctrl+N</kbd> - Add new item
            (copies location from above)
          </li>
          <li>
            <kbd className="bg-muted rounded px-1">Tab</kbd> - Navigate fields
          </li>
        </ul>
      </div>
    </FormWrapper>
  );
}
