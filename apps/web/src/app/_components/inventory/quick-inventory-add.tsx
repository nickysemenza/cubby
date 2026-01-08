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

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { FormProvider, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { ComboboxFieldWithSearch } from "~/app/_components/form-utils";
import { amount } from "~/codec/codec";
import { Button } from "~/components/ui/button";
import {
  getOptionalProductId,
  requiredProductField,
} from "~/schemas/form-fields";
import type { LocationId } from "~/schemas/identifiers";
import { useTRPC } from "~/trpc/react";
import { AmountFieldGroup } from "./amount-field-group";

interface QuickInventoryAddProps {
  locationId: LocationId;
  onSuccess: () => void;
}

const formSchema = z.object({
  product: requiredProductField,
  amount: amount,
});

type FormValues = z.input<typeof formSchema>;

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
    api.inventory.create.mutationOptions({
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
        <div className="flex flex-col gap-2">
          <ComboboxFieldWithSearch
            form={form}
            name="product"
            label="Add Product"
            searchType="product"
          />
          <div className="flex items-end gap-2">
            <AmountFieldGroup
              form={form}
              valuePath="amount.value"
              unitPath="amount.unit"
            />
            <Button
              type="submit"
              size="icon"
              disabled={createMutation.isPending}
              className="mb-0.5"
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </form>
    </FormProvider>
  );
}
