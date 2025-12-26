/**
 * QuickInventoryAdd - Compact inline form for adding inventory items to a location.
 *
 * Use this component when:
 * - Embedding a quick-add form within a location detail page
 * - The target location is already known (passed as prop)
 * - Simple single-item additions without barcode scanning
 *
 * For rapid multi-item data entry with barcode scanning, keyboard shortcuts,
 * and location context navigation, use the dedicated QuickCaptureForm page instead.
 *
 * @see /inventory/quick-capture - Full-featured rapid entry form
 */
"use client";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTRPC } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import type { LocationId } from "~/schemas/identifiers";
import { useMutation } from "@tanstack/react-query";
import { ComboboxFieldWithSearch } from "~/app/_components/form-utils";
import { ComboboxItem } from "../combobox/combobox-types";
import { getOptionalProductId } from "~/schemas/form-fields";
import { AmountFieldGroup } from "./amount-field-group";
import { FormProvider } from "react-hook-form";
import { amount } from "~/codec/codec";

interface QuickInventoryAddProps {
  locationId: LocationId;
  onSuccess: () => void;
}

const formSchema = z.object({
  product: ComboboxItem.refine((item) => item !== null, {
    message: "Please select a product",
  }),
  amount: amount,
});

type FormValues = z.infer<typeof formSchema>;

export function QuickInventoryAdd({
  locationId,
  onSuccess,
}: QuickInventoryAddProps) {
  const api = useTRPC();

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      product: undefined,
      amount: { value: 1, unit: "" },
    },
  });

  const createMutation = useMutation(
    api.inventoryItem.create.mutationOptions({
      onSuccess: () => {
        toast.success("Item added to inventory");
        form.reset({ product: undefined, amount: { value: 1, unit: "" } });
        onSuccess();
      },
      onError: (err) => {
        toast.error(err.message || "Failed to add item");
      },
    }),
  );

  const onSubmit = async (values: FormValues) => {
    await createMutation.mutateAsync({
      productId: getOptionalProductId(values.product)!,
      locationId,
      amount: values.amount,
    });
  };

  return (
    <FormProvider {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)}>
        <div className="flex items-end gap-2">
          <div className="min-w-[200px] flex-1">
            <ComboboxFieldWithSearch
              form={form}
              name="product"
              label="Add Product"
              searchType="product"
            />
          </div>
          <div className="flex-shrink-0">
            <AmountFieldGroup
              form={form}
              valuePath="amount.value"
              unitPath="amount.unit"
            />
          </div>
          <Button
            type="submit"
            size="icon"
            disabled={createMutation.isPending}
            className="mb-0.5 flex-shrink-0"
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
      </form>
    </FormProvider>
  );
}
